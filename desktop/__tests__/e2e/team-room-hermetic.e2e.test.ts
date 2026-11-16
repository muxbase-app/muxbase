import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { MuxBasePane } from 'muxbase/core';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {} from '../../src/renderer/env.js';
import { IPC } from '../../src/shared/ipc-channels.js';
import type { ElectronSettings, SerializableActionResult } from '../../src/shared/ipc-types.js';
import type { PaneActivitySnapshot } from '../../src/shared/pane-activity.js';
import type { TeamActionResponse, TeamDecision, TeamRun, TeamStartRequest, TeamStartResponse } from '../../src/shared/team-types.js';
import { closeElectronApp, getAppWindow, pollUntil } from './e2e-helpers.js';
import { TEAM_FIXTURE_PACKAGE_NAME } from './support/team-fake-agent.js';
import { readBaselineAxeSource } from './ui-baseline.js';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js');
const PACKAGED_EXECUTABLE = process.env.MUXBASE_E2E_PACKAGED_EXECUTABLE;
const BRIEF = 'Set answer.json answer to 42, preserve the writer identity, and run the provided checks.';
const WAIT = 90_000;

interface TeamAxeRunner {
  run(context: string, options: { runOnly: { type: 'tag'; values: string[] } }): Promise<{
    violations: Array<{ id: string; nodes: Array<{ failureSummary?: string; target: string[] }> }>;
  }>;
}

describe.runIf(process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_FAKE_AGENTS === '1')('Hermetic Team Room', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  const consoleErrors: string[] = [];

  async function invoke<T>(channel: string, request?: unknown): Promise<T> {
    return page.evaluate(({ channel, request }) => request === undefined
      ? window.muxbase.invoke<T>(channel) : window.muxbase.invoke<T>(channel, request), { channel, request });
  }

  async function getRun(runId: string): Promise<TeamRun> {
    const runs = await invoke<TeamRun[]>(IPC.TEAM_LIST);
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Team run disappeared: ${runId}`);
    return run;
  }

  async function waitForRun(runId: string, predicate: (run: TeamRun) => boolean): Promise<TeamRun> {
    try {
      await pollUntil(async () => {
        const run = await getRun(runId);
        if (run.status === 'failed') throw new Error(`Team run failed: ${JSON.stringify(run)}`);
        return predicate(run);
      }, { interval: 250, label: `Team ${runId}`, timeout: WAIT - 30_000 });
    } catch (error) {
      const run = await getRun(runId);
      const inputs = readFileSync(join(homedir(), 'team-fake-launches.ndjson'), 'utf8').slice(-5000);
      const activity = await invoke(IPC.PANE_ACTIVITY_SNAPSHOT_GET);
      const sessions = await Promise.all(run.members.map((member) => invoke(IPC.AGENT_SESSION_GET, { paneId: member.paneId })));
      throw new Error(`Team progress failed: ${JSON.stringify(run).slice(0, 6000)}\nFake inputs: ${inputs}\nActivity: ${JSON.stringify(activity)}\nSessions: ${JSON.stringify(sessions).slice(-6000)}`, { cause: error });
    }
    return getRun(runId);
  }

  async function startRun(overrides: Partial<TeamStartRequest> = {}): Promise<TeamRun> {
    const previous: unknown = JSON.parse(readFileSync(join(root, 'answer.json'), 'utf8'));
    if (previous && typeof previous === 'object' && 'answer' in previous && previous.answer !== 0) {
      writeFileSync(join(root, 'answer.json'), '{"answer":0,"writer":"base"}\n');
      execFileSync('git', ['add', 'answer.json'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'test: reset Team fixture answer'], { cwd: root });
    }
    const started = await invoke<TeamStartResponse>(IPC.TEAM_START, {
      brief: BRIEF,
      checkCommand: `${JSON.stringify(process.execPath)} --test check.test.mjs`,
      ...overrides,
    });
    expect(started.success, started.error).toBe(true);
    if (!started.run) throw new Error('Team launch did not return its run');
    return waitForRun(started.run.id, (run) => run.members.length >= 2);
  }

  async function stopRun(run: TeamRun): Promise<void> {
    const stopped = await invoke<TeamActionResponse>(IPC.TEAM_FINISH, { outcome: 'stopped', runId: run.id });
    expect(stopped.success, stopped.error).toBe(true);
    expect((await getRun(run.id)).status).toBe('stopped');
  }

  async function waitForSettledAnimations(): Promise<void> {
    await pollUntil(async () => page.evaluate(() => document.getAnimations().every((animation) => (
      animation.effect?.getTiming().iterations === Infinity
      || (!animation.pending && animation.playState !== 'running')
    ))), { timeout: 5_000, interval: 50, label: 'Settled animations' });
  }

  async function screenshot(name: string): Promise<void> {
    const directory = process.env.MUXBASE_E2E_SCREENSHOTS;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await waitForSettledAnimations();
    await page.screenshot({ path: join(directory, name), fullPage: true });
  }

  async function checkAccessibility(): Promise<void> {
    await waitForSettledAnimations();
    await page.evaluate(readBaselineAxeSource());
    const violations = await page.evaluate(async () => {
      const source: Window & { axe?: TeamAxeRunner } = window;
      if (!source.axe) throw new Error('The installed accessibility scanner did not load.');
      const result = await source.axe.run('[data-testid="team-room"]', {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      });
      return result.violations;
    });
    expect(violations, JSON.stringify(violations)).toEqual([]);
  }

  async function mergeFromUi(runId: string, verifyUx = true): Promise<void> {
    await selectRunFromUi(runId);
    await page.getByTestId('team-final').waitFor();
    if (verifyUx) {
      await checkReadyUx(runId);
      await screenshot('team-ready.png');
    }
    await page.getByTestId('team-merge').click();
    for (let step = 0; step < 8; step += 1) {
      const dialog = page.getByRole('dialog').last();
      await pollUntil(async () => (await getRun(runId)).status === 'merged' || await dialog.isVisible(), {
        interval: 100, timeout: 20_000, label: 'Team human merge step',
      });
      if ((await getRun(runId)).status === 'merged') {
        await waitForRun(runId, (run) => run.mergeIntent?.state === 'cleaned');
        return;
      }
      const textbox = dialog.getByRole('textbox').first();
      if (await textbox.isVisible() && !(await textbox.inputValue())) {
        await textbox.fill('feat: apply reviewed Team fixture');
      }
      const approve = dialog.getByRole('button', {
        name: /^(?:Confirm|Continue|Merge|Commit|Yes|Run tests)\b/i,
      });
      expect(await approve.count(), await dialog.innerText()).toBe(1);
      await approve.click();
    }
    throw new Error('The reviewed Team result did not complete its human merge flow');
  }

  async function selectRunFromUi(runId: string): Promise<void> {
    await page.getByTestId('sidebar-team').click();
    if ((await invoke<TeamRun[]>(IPC.TEAM_LIST)).length > 1) {
      const selector = page.getByRole('combobox', { name: 'Team run', exact: true });
      await selector.waitFor();
      await selector.selectOption(runId);
    }
  }

  async function selectThemeFromUi(theme: ElectronSettings['theme']): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const installNotice = page.getByRole('complementary', { name: 'Automatic update setup' });
    if (await installNotice.isVisible()) await installNotice.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await pollUntil(async () => (await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET)).theme === theme, {
      timeout: 5_000, interval: 50, label: 'Appearance theme persistence',
    });
  }

  async function checkNarrowContext(run: TeamRun): Promise<void> {
    await page.setViewportSize({ width: 800, height: 640 });
    const trigger = page.getByRole('button', { name: 'Run context', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const context = page.getByRole('dialog', { name: 'Run context', exact: true });
    await context.waitFor();
    expect(await context.getByText(run.brief, { exact: true }).isVisible()).toBe(true);
    expect(await context.getByRole('button', { name: /^Open .+ pane$/ }).count()).toBe(run.members.length);
    const close = context.getByRole('button', { name: 'Close run context' });
    await pollUntil(async () => close.evaluate((element) => document.activeElement === element), {
      timeout: 5_000, interval: 50, label: 'Run context initial keyboard focus',
    });
    await page.keyboard.press('Shift+Tab');
    expect(await context.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await close.evaluate((element) => document.activeElement === element)).toBe(true);
    await checkAccessibility();
    await screenshot('team-context-narrow.png');
    await page.keyboard.press('Escape');
    await context.waitFor({ state: 'hidden' });
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.setViewportSize({ width: 640, height: 600 });
    expect(await page.getByTestId('team-room').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const merge = await page.getByTestId('team-merge').boundingBox();
    if (!merge) throw new Error('Narrow Team merge action has no bounds');
    expect(merge.y + merge.height).toBeLessThanOrEqual(600);
    expect(await trigger.isVisible()).toBe(true);
    await screenshot('team-ready-narrow.png');
  }

  async function checkReadyUx(runId: string): Promise<void> {
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const originalTheme = (await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET)).theme;
    await selectThemeFromUi('dark');
    await selectRunFromUi(runId);
    await page.setViewportSize({ width: 960, height: 720 });
    await pollUntil(async () => await page.getByText('Your team finished. The change is ready for your merge.', { exact: true }).count() === 0, {
      timeout: 5_000, interval: 50, label: 'Ready result unobstructed by an earlier completion toast',
    });
    const tabs = page.getByRole('tablist', { name: 'Team activity' }).getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    expect(await tabs.nth(1).getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('team-final').isVisible()).toBe(true);
    const action = await page.getByTestId('team-merge').boundingBox();
    expect(action).not.toBeNull();
    expect(action!.y + action!.height).toBeLessThanOrEqual(720);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.keyboard.press('Home');
    const check = page.getByTestId('team-check').first();
    await check.locator('summary').focus();
    await page.keyboard.press('Enter');
    expect(await check.getAttribute('open')).not.toBeNull();
    expect(await check.locator('pre').innerText()).toContain('tests');
    await check.locator('summary').focus();
    await page.keyboard.press('Tab');
    expect(await check.locator('pre').evaluate((element) => document.activeElement === element)).toBe(true);
    await checkAccessibility();
    await screenshot('team-ready-compact.png');
    await page.getByTestId('team-filter-contested').click();
    expect(await page.getByText('No contested activity yet.', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByTestId('team-merge').isVisible()).toBe(true);
    await screenshot('team-empty-filter.png');
    await tabs.first().click();
    const diffTrigger = page.getByRole('button', { name: 'View changes', exact: true });
    await diffTrigger.focus();
    await page.keyboard.press('Enter');
    const diff = page.getByRole('dialog', { name: 'Review writer changes' });
    await diff.waitFor();
    await pollUntil(async () => (await diff.innerText()).includes('answer.json'), {
      timeout: 10_000, interval: 100, label: 'Selected writer live diff',
    });
    await screenshot('team-review-diff.png');
    await page.keyboard.press('Escape');
    await diff.waitFor({ state: 'hidden' });
    expect(await diffTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await page.getByTestId('team-room').isVisible()).toBe(true);
    expect(await page.getByRole('textbox', { name: 'Message the team', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Send note', exact: true }).count()).toBe(0);
    expect(await page.getByText('Ready for your review. Inspect changes, then merge when ready.', { exact: true }).count()).toBe(1);
    expect(await page.getByText('Ready for your review. Inspect changes, then merge when ready.', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole('status', { name: 'Run status' }).innerText()).toBe('Ready to merge');
    await selectThemeFromUi('light');
    await pollUntil(async () => page.evaluate(() => document.documentElement.dataset.theme === 'light'), {
      timeout: 5_000, interval: 50, label: 'Team light theme',
    });
    await selectRunFromUi(runId);
    await checkAccessibility();
    await screenshot('team-ready-light.png');
    await selectThemeFromUi(originalTheme);
    await selectRunFromUi(runId);
    await checkNarrowContext(await getRun(runId));
    await page.setViewportSize(viewport);
  }

  function openDecision(run: TeamRun): TeamDecision {
    const decision = run.decisions.findLast((candidate) => !candidate.chosen);
    if (!decision) throw new Error(`Team is waiting without an open decision: ${JSON.stringify(run)}`);
    return decision;
  }

  async function boot(): Promise<void> {
    const excluded = new Set([
      'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    ]);
    app = await electron.launch({
      args: PACKAGED_EXECUTABLE ? [] : [MAIN_ENTRY],
      ...(PACKAGED_EXECUTABLE ? { executablePath: PACKAGED_EXECUTABLE } : {}),
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key))),
        MUXBASE_DEV: 'true',
        MUXBASE_E2E: '1',
        MUXBASE_E2E_TEAM_FAKE: '1',
        MUXBASE_E2E_USER_DATA_DIR: join(root, '.muxbase', 'e2e-user-data'),
        NODE_ENV: 'test',
      },
    });
    page = await getAppWindow(app);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
    const agentPath = await app.evaluate(() => process.env.PATH);
    for (const agent of ['claude', 'codex']) {
      const version = execFileSync(agent, ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: agentPath },
        timeout: 5_000,
      });
      expect(version, `${agent} must be the isolated fake, never an authenticated CLI`).toContain('muxbase-e2e');
    }
    await invoke(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'disableExternalNetwork', value: true });
    await invoke(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'enableAgentLifecycleAdapters', value: true });
  }

  async function crashAndRestart(): Promise<void> {
    const child = app.process();
    child.kill('SIGKILL');
    await pollUntil(async () => child.signalCode !== null || child.exitCode !== null, {
      timeout: 10_000, interval: 50, label: 'crashed Electron exit',
    });
    await boot();
  }

  beforeAll(async () => {
    expect(basename(homedir()).startsWith('muxbase-home-e2e-')).toBe(true);
    expect(process.env.TMUX_TMPDIR).toContain('muxbase-tmux-e2e-');
    expect(existsSync(PACKAGED_EXECUTABLE ?? MAIN_ENTRY), 'Build the Electron app before this test').toBe(true);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-team-hermetic-')));
    mkdirSync(join(root, '.muxbase'));
    writeFileSync(join(root, '.gitignore'), '.muxbase/\n.muxbase-hooks/\n');
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
      name: TEAM_FIXTURE_PACKAGE_NAME, private: true, scripts: { test: 'node --test check.test.mjs' },
    })}\n`);
    writeFileSync(join(root, 'answer.json'), '{"answer":0,"writer":"base"}\n');
    writeFileSync(join(root, 'check.test.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('the requested answer is implemented', () => {",
      "  const result = JSON.parse(readFileSync('answer.json', 'utf8'));",
      "  assert.equal(result.answer, 42);",
      "  assert.ok(['claude', 'codex'].includes(result.writer));",
      '});',
      '',
    ].join('\n'));
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 'team-e2e@muxbase.test'],
      ['config', 'user.name', 'Team E2E'],
      ['add', '.'],
      ['commit', '-m', 'test: create Team fixture'],
    ]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    await boot();
  }, 60_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  afterEach(async ({ task }) => {
    writeFileSync(join(root, '.muxbase', 'release-hook'), 'release\n');
    rmSync(join(root, '.muxbase-hooks', 'post_merge'), { force: true });
    const runs = await invoke<TeamRun[]>(IPC.TEAM_LIST);
    if (task.result?.state === 'fail') {
      await screenshot('team-failed.png');
      const activity = await invoke(IPC.PANE_ACTIVITY_SNAPSHOT_GET);
      process.stderr.write(`Team failure state: ${JSON.stringify(runs).slice(-8000)}\nActivity: ${JSON.stringify(activity).slice(-8000)}\n`);
      const panes = await invoke<MuxBasePane[]>(IPC.PANE_LIST);
      for (const pane of panes.filter((candidate) => runs.some((run) => run.members.some((member) => member.paneId === candidate.id)))) {
        const terminal = spawnSync('tmux', ['capture-pane', '-p', '-t', pane.paneId], { encoding: 'utf8' });
        const diagnostic = terminal.status === 0 ? terminal.stdout : `Capture failed: ${terminal.error?.message ?? terminal.stderr}`;
        process.stderr.write(`Fixture terminal ${pane.id}: ${diagnostic.slice(-2500)}\n`);
      }
    }
    for (const run of runs) {
      if (!['stopped', 'merged'].includes(run.status) && !run.mergeIntent) await stopRun(run);
    }
    expect(consoleErrors).toEqual([]);
  }, 30_000);

  it('renders Settings defaults and keeps Council overrides local to the launch', async () => {
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('team-launch').waitFor();
    expect(await page.getByTestId('view-team').getAttribute('aria-pressed')).toBe('true');
    expect(await page.getByTestId('team-mode-pair').getAttribute('aria-checked')).toBe('true');
    await screenshot('team-launch.png');
    await page.getByTestId('team-config').locator('summary').click();
    expect(await page.getByRole('combobox', { name: 'Writer', exact: true }).inputValue()).toBe('codex');
    expect(await page.getByRole('combobox', { name: 'Reviewer', exact: true }).inputValue()).toBe('claude');
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 960, height: 720 });
    const startBounds = await page.getByTestId('team-start').boundingBox();
    if (!startBounds) throw new Error('Start action has no bounds');
    expect(startBounds.y + startBounds.height).toBeLessThanOrEqual(720);
    await page.getByTestId('team-guardrails').locator('summary').click();
    const timeBudget = page.getByRole('spinbutton', { name: 'Time budget in minutes', exact: true });
    await timeBudget.focus();
    const limitBounds = await timeBudget.boundingBox();
    if (!limitBounds) throw new Error('Launch limits have no bounds');
    expect(limitBounds.y + limitBounds.height).toBeLessThanOrEqual(720);
    await screenshot('team-launch-compact.png');
    await page.setViewportSize(viewport);
    await page.getByTestId('team-mode-council').click();
    expect((await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET)).teamDefaultMode).toBe('pair');
    const retainedBrief = 'Preserve this planned Team brief while I change the defaults.';
    await page.getByRole('textbox', { name: 'Brief', exact: true }).fill(retainedBrief);
    await page.getByRole('button', { name: 'Change defaults in Settings' }).click();
    await page.getByTestId('team-settings').waitFor();
    const budgetBounds = await page.getByRole('spinbutton', { name: 'Token budget', exact: true }).boundingBox();
    if (!budgetBounds) throw new Error('Settings token budget has no bounds');
    expect(budgetBounds.width).toBeGreaterThanOrEqual(140);
    await screenshot('team-settings.png');
    await page.getByRole('combobox', { name: 'Default mode', exact: true }).selectOption('council');
    await page.getByRole('spinbutton', { name: 'Maximum fix rounds', exact: true }).fill('3');
    await page.getByRole('spinbutton', { name: 'Maximum fix rounds', exact: true }).press('Tab');
    await pollUntil(async () => {
      const settings = await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET);
      return settings.teamDefaultMode === 'council' && settings.teamMaxFixRounds === 3;
    }, { interval: 50, timeout: 5_000, label: 'Team defaults persistence' });
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('team-launch').waitFor();
    expect(await page.getByRole('textbox', { name: 'Brief', exact: true }).inputValue()).toBe(retainedBrief);
    expect(await page.getByTestId('team-mode-council').getAttribute('aria-checked')).toBe('true');
    await page.getByTestId('team-mode-pair').click();
    expect((await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET)).teamDefaultMode).toBe('council');
    await invoke(IPC.ELECTRON_SETTINGS_RESET);
    await invoke(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'disableExternalNetwork', value: true });
    await invoke(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'enableAgentLifecycleAdapters', value: true });
    await page.reload();
    await page.waitForSelector('[data-testid="app-shell"]');
  }, 30_000);

  it('uses authoritative Pair defaults, blocks premature ordinary merges, and binds checked approval', async () => {
    const defaults = await invoke<ElectronSettings>(IPC.ELECTRON_SETTINGS_GET);
    expect(defaults).toMatchObject({
      teamDefaultMode: 'pair', teamMaxFixRounds: 2,
      teamReviewerAgent: 'claude', teamWriterAgent: 'codex',
    });
    const previousIds = new Set((await invoke<TeamRun[]>(IPC.TEAM_LIST)).map((run) => run.id));
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('team-launch').waitFor();
    expect(await page.getByTestId('team-mode-pair').getAttribute('aria-checked')).toBe('true');
    await page.getByTestId('team-config').locator('summary').click();
    expect(await page.getByRole('combobox', { name: 'Writer', exact: true }).inputValue()).toBe('codex');
    expect(await page.getByRole('combobox', { name: 'Reviewer', exact: true }).inputValue()).toBe('claude');
    await page.getByRole('textbox', { name: 'Brief', exact: true }).fill(BRIEF);
    await page.getByTestId('team-guardrails').locator('summary').click();
    await page.getByRole('textbox', { name: 'Check command', exact: true }).fill(`${JSON.stringify(process.execPath)} --test check.test.mjs`);
    await screenshot('team-launch-pair-filled.png');
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    await pollUntil(async () => (await invoke<TeamRun[]>(IPC.TEAM_LIST)).some((run) => !previousIds.has(run.id) && run.members.length >= 2), {
      timeout: 30_000, interval: 100, label: 'Visible Pair launch creates the team',
    });
    const started = (await invoke<TeamRun[]>(IPC.TEAM_LIST)).find((run) => !previousIds.has(run.id));
    if (!started) throw new Error('The visible Team launch did not create its run');
    expect(started.brief).toBe(BRIEF);
    expect(started.mode).toBe('pair');
    const writer = started.members.find((member) => member.role === 'developer');
    if (!writer) throw new Error('Pair did not create its writer');
    expect(started.members).toHaveLength(2);
    const premature = await invoke<SerializableActionResult>(IPC.PANE_MERGE, { paneId: writer.paneId });
    expect(premature.type).toBe('error');
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    expect(ready.approval).toMatchObject({ kind: 'review' });
    expect(ready.approval?.checkedSnapshot).toBe(ready.approval?.snapshotSha);
    expect(ready.rounds.some((round) => round.kind === 'design')).toBe(false);
    const launches = readFileSync(join(homedir(), 'team-fake-launches.ndjson'), 'utf8');
    expect(launches).toContain('--permission-mode');
    expect(launches).toContain('plan');
    const prepared = await invoke<TeamActionResponse>(IPC.TEAM_PREPARE_MERGE, { runId: ready.id });
    expect(prepared.success, prepared.error).toBe(true);
    const hooks = join(root, '.muxbase-hooks');
    const effects = join(root, '.muxbase', 'hook-receipts');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post_merge'), '#!/bin/sh\nprintf \'%s\\n\' "$MUXBASE_TEAM_MERGE_ID" >> "$MUXBASE_ROOT/.muxbase/hook-receipts"\n');
    chmodSync(join(hooks, 'post_merge'), 0o755);
    await mergeFromUi(ready.id);
    const merged = await waitForRun(ready.id, (run) => run.mergeIntent?.hook?.state === 'succeeded');
    expect(readFileSync(effects, 'utf8').trim().split('\n')).toEqual([merged.mergeIntent?.operationId]);
    expect(JSON.parse(readFileSync(join(root, 'answer.json'), 'utf8'))).toMatchObject({
      answer: 42, writer: 'codex',
    });
    await crashAndRestart();
    expect((await getRun(ready.id)).mergeIntent?.hook?.state).toBe('succeeded');
    expect(readFileSync(effects, 'utf8').trim().split('\n')).toEqual([merged.mergeIntent?.operationId]);
  }, WAIT);

  it('preserves uncertain external hook effects after a crash without repeating them', async () => {
    const started = await startRun();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    const prepared = await invoke<TeamActionResponse>(IPC.TEAM_PREPARE_MERGE, { runId: ready.id });
    expect(prepared.success, prepared.error).toBe(true);
    const hooks = join(root, '.muxbase-hooks');
    const receipts = join(root, '.muxbase', 'running-hook-receipts');
    const completed = join(root, '.muxbase', 'hook-completed');
    const release = join(root, '.muxbase', 'release-hook');
    rmSync(release, { force: true });
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post_merge'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$MUXBASE_TEAM_MERGE_ID" >> "$MUXBASE_METADATA_DIR/running-hook-receipts"',
      'i=0',
      'while [ ! -f "$MUXBASE_METADATA_DIR/release-hook" ] && [ "$i" -lt 30 ]; do',
      '  sleep 1',
      '  i=$((i+1))',
      'done',
      'printf completed > "$MUXBASE_METADATA_DIR/hook-completed"',
      '',
    ].join('\n'));
    chmodSync(join(hooks, 'post_merge'), 0o755);
    try {
      await mergeFromUi(ready.id, false);
      await pollUntil(async () => existsSync(receipts), { timeout: 5_000, interval: 50, label: 'Real external hook effect' });
      const running = await getRun(ready.id);
      expect(running.mergeIntent?.hook?.state).toBe('running');
      await crashAndRestart();
      writeFileSync(release, 'release\n');
      const restored = await waitForRun(ready.id, (run) => run.mergeIntent?.hook?.state === 'unknown');
      await pollUntil(async () => existsSync(completed), { timeout: 5_000, interval: 50, label: 'Bounded original hook exit' });

      expect(restored.status).toBe('merged');
      expect(restored.error).toContain('will not repeat the hook');
      expect(readFileSync(receipts, 'utf8').trim().split('\n')).toEqual([running.mergeIntent?.operationId]);
      await selectRunFromUi(restored.id);
      expect(await page.getByTestId('team-recovery').filter({ hasText: 'will not repeat the hook' }).isVisible()).toBe(true);
      await checkAccessibility();
      await screenshot('team-recovered-hook-error.png');
    } finally {
      writeFileSync(release, 'release\n');
    }
  }, WAIT);

  it('checks isolated Duel candidates and requires a human winner before either candidate can merge', async () => {
    const started = await startRun({
      duelSides: [{ agent: 'codex' }, { agent: 'claude' }],
      mode: 'duel',
    });
    const choosing = await waitForRun(started.id, (run) => run.status === 'waiting'
      && run.decisions.some((decision) => decision.kind === 'duel-winner' && !decision.chosen));
    const decision = openDecision(choosing);
    const writerA = choosing.members.find((member) => member.role === 'developer');
    const writerB = choosing.members.find((member) => member.role === 'architect');
    if (!writerA || !writerB) throw new Error('Duel is missing its isolated candidates');
    expect(writerA.worktreePath).not.toBe(writerB.worktreePath);
    for (const member of [writerA, writerB]) {
      const premature = await invoke<SerializableActionResult>(IPC.PANE_MERGE, { paneId: member.paneId });
      expect(premature.type).toBe('error');
    }
    const winner = decision.options.find((option) => /architect|writer b|candidate b/i.test(option.title));
    if (!winner) throw new Error(`Duel has no Writer B choice: ${JSON.stringify(decision)}`);
    await selectRunFromUi(choosing.id);
    await pollUntil(async () => await page.getByText(`Team needs your call: ${decision.title}`, { exact: true }).count() === 0, {
      timeout: 5_000, interval: 50, label: 'Visible Duel gate unobstructed by its own warning toast',
    });
    const humanGate = page.getByTestId('team-next-action');
    const sheetTrigger = humanGate.getByRole('button', { name: 'Compare and choose', exact: true });
    if (await sheetTrigger.getAttribute('aria-expanded') === 'true') await sheetTrigger.click();
    await page.getByTestId('team-filter-agreed').click();
    await sheetTrigger.click();
    expect(await sheetTrigger.getAttribute('aria-expanded')).toBe('true');
    await humanGate.focus();
    expect(await humanGate.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await humanGate.getByTestId('team-decision-confirm').isDisabled()).toBe(true);
    await checkAccessibility();
    await screenshot('team-duel-human-decision.png');
    await humanGate.getByRole('radio', { name: winner.title, exact: true }).click();
    await humanGate.getByTestId('team-decision-confirm').click();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    expect(ready.selectedSourceId).toBe(writerB.paneId);
    expect(ready.approval?.kind).toBe('review');
    const rejected = await invoke<SerializableActionResult>(IPC.PANE_MERGE, { paneId: writerA.paneId });
    expect(rejected.type).toBe('error');
    expect((await getRun(ready.id)).approval).toEqual(ready.approval);
    const prepared = await invoke<TeamActionResponse>(IPC.TEAM_PREPARE_MERGE, { runId: ready.id });
    expect(prepared.success, prepared.error).toBe(true);
    await mergeFromUi(ready.id, false);
    expect(JSON.parse(readFileSync(join(root, 'answer.json'), 'utf8'))).toMatchObject({
      answer: 42, writer: 'claude',
    });
    expect((await getRun(ready.id)).mergeIntent?.state).toBe('cleaned');
  }, WAIT);

  it('requires a reasoned human waiver for a real failed check and keeps that reason visible', async () => {
    const check = join(root, '.muxbase', 'known-failure.mjs');
    writeFileSync(check, "process.stderr.write('Known fixture check failure\\n');\nprocess.exitCode = 1;\n");
    const started = await startRun({
      checkCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(check)}`,
      maxFixRounds: 1,
    });
    const waiting = await waitForRun(started.id, (run) => run.status === 'waiting'
      && run.decisions.some((decision) => decision.kind === 'fix-limit' && !decision.chosen));
    const decision = openDecision(waiting);
    const accept = decision.options.find((option) => option.id === 'accept');
    if (!accept) throw new Error('Failed checks did not offer an explicit human waiver');
    await selectRunFromUi(waiting.id);
    const gate = page.getByTestId('team-next-action');
    await gate.getByRole('radio', { name: accept.title, exact: true }).click();
    const confirm = gate.getByTestId('team-decision-confirm');
    expect(await confirm.isDisabled()).toBe(true);
    const reason = `The deterministic fixture failure is expected; retain follow-up ${'compatibility-'.repeat(30)}review before release.`;
    const waiver = gate.getByRole('textbox', { name: 'Waiver reason', exact: true });
    expect(await waiver.evaluate((element) => element.tagName)).toBe('TEXTAREA');
    await waiver.fill(reason);
    expect(await confirm.isEnabled()).toBe(true);
    await checkAccessibility();
    await screenshot('team-check-waiver-decision.png');
    await confirm.click();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    expect(ready.approval).toMatchObject({ kind: 'waiver', reason });
    const result = page.getByTestId('team-final');
    await result.waitFor();
    expect(await result.getByText('Approval waived', { exact: true }).isVisible()).toBe(true);
    expect(await result.getByText(reason, { exact: true }).isVisible()).toBe(true);
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    try {
      await page.setViewportSize({ width: 800, height: 640 });
      expect(await page.getByTestId('team-room').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByTestId('team-merge').focus();
      const bounds = await page.getByTestId('team-merge').boundingBox();
      if (!bounds) throw new Error('Waived approval has no reachable merge action');
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
      await checkAccessibility();
      await screenshot('team-check-waiver-ready-narrow.png');
    } finally {
      await page.setViewportSize(viewport);
    }
    await stopRun(ready);
  }, WAIT);

  it('pauses on observed tokens, persists an explicit extension, and recovers an interrupted writer', async () => {
    const started = await startRun({ limits: { maxDurationMs: 60_000, maxTokens: 120 } });
    const paused = await waitForRun(started.id, (run) => run.status === 'waiting'
      && run.decisions.some((decision) => decision.kind === 'limit' && !decision.chosen));
    expect(paused.tokenUsage).toBeGreaterThanOrEqual(120);
    const writer = paused.members.find((member) => member.role === 'developer');
    const panes = await invoke<MuxBasePane[]>(IPC.PANE_LIST);
    const writerPane = panes.find((pane) => pane.id === writer?.paneId);
    if (!writer || !writerPane) throw new Error('Paused Pair has no preserved writer');
    execFileSync('tmux', ['send-keys', '-t', writerPane.paneId, 'C-c']);
    await pollUntil(async () => {
      const activity = (await invoke<PaneActivitySnapshot>(IPC.PANE_ACTIVITY_SNAPSHOT_GET)).panes[writer.paneId];
      return activity?.certainty === 'confirmed' && activity.liveness === 'stopped';
    }, { timeout: 10_000, interval: 100, label: 'Interrupted writer stopped liveness' });
    const decision = openDecision(paused);
    await selectRunFromUi(paused.id);
    const extend = decision.options.find((option) => option.id === 'extend');
    if (!extend) throw new Error('Budget pause has no explicit extension option');
    await page.getByRole('radio', { name: extend.title, exact: true }).click();
    await page.getByRole('spinbutton', { name: 'New total token limit', exact: true }).fill('10000');
    await page.getByRole('spinbutton', { name: 'Additional minutes', exact: true }).fill('60');
    await page.getByTestId('team-decision-confirm').click();
    const resumed = await waitForRun(started.id, (run) => run.status === 'ready'
      || (run.status === 'waiting' && run.decisions.some((candidate) => candidate.kind === 'member-failed' && !candidate.chosen)));
    if (resumed.status === 'waiting') {
      const changed = openDecision(resumed);
      expect(changed.why).toMatch(/activity or pane incarnation changed/i);
      const retry = changed.options.find((option) => option.id === 'retry');
      if (!retry) throw new Error('Readiness invalidation has no explicit retry action');
      const gate = page.getByTestId('team-next-action');
      await gate.getByRole('radio', { name: retry.title, exact: true }).click();
      await gate.getByTestId('team-decision-confirm').click();
    }
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    expect(ready.limits?.maxTokens).toBe(10_000);
    expect(ready.approval?.kind).toBe('review');
    await stopRun(ready);
  }, WAIT);

  it('stops Council at its design gate without deleting the owned writer or claiming a build happened', async () => {
    const started = await startRun({ mode: 'council', policy: 'every-gate' });
    const waiting = await waitForRun(started.id, (run) => run.status === 'waiting');
    expect(waiting.rounds.some((round) => round.kind === 'build')).toBe(false);
    const writer = waiting.members.find((member) => !member.readOnly);
    if (!writer) throw new Error('Council has no owned writer');
    await selectRunFromUi(waiting.id);
    await page.getByTestId('team-stop').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop run', exact: true }).click();
    await waitForRun(started.id, (run) => run.status === 'stopped');
    expect(existsSync(writer.worktreePath)).toBe(true);
    const panes = await invoke<MuxBasePane[]>(IPC.PANE_LIST);
    expect(panes.some((pane) => pane.id === writer.paneId)).toBe(true);
    expect(panes.some((pane) => waiting.members.some((member) => member.readOnly && member.paneId === pane.id))).toBe(false);
  }, WAIT);

  it('recovers approval after a real main-process crash and repairs a torn journal before the next write', async () => {
    const started = await startRun();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    const journals = readdirSync(join(root, '.muxbase'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:jsonl|ndjson)$/.test(entry.name)
        && (entry.parentPath.includes(ready.id) || entry.name.includes(ready.id)))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(journals).toHaveLength(1);
    appendFileSync(journals[0], '{"version":1,');
    await crashAndRestart();
    expect((await getRun(ready.id)).approval).toEqual(ready.approval);
    const note = 'Recovered after the intentionally torn journal tail';
    const noted = await invoke<TeamActionResponse>(IPC.TEAM_NOTE, { runId: ready.id, text: note });
    expect(noted.success, noted.error).toBe(true);
    expect(readFileSync(journals[0], 'utf8')).toContain(note);
    await crashAndRestart();
    const restored = await getRun(ready.id);
    expect(restored.status).toBe('ready');
    expect(restored.approval).toEqual(ready.approval);
    expect(restored.revision).toBeGreaterThan(ready.revision ?? 0);
    await stopRun(restored);
    expect(consoleErrors).toEqual([]);
  }, WAIT);

  it('drains an owned check after a main-process crash and asks before repeating its uncertain effects', async () => {
    const marker = join(root, '.muxbase', 'check-attempts');
    const script = join(root, '.muxbase', 'owned-check.mjs');
    writeFileSync(script, [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const started = await startRun({
      checkCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    });
    await pollUntil(async () => existsSync(marker), {
      timeout: 30_000, interval: 100, label: 'Owned Team check started',
    });
    const pid = Number(readFileSync(marker, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect((await getRun(started.id)).checkPending).toBe(true);

    await crashAndRestart();

    await pollUntil(async () => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
      } catch (error) {
        if ((error as { status?: number }).status === 1) return true;
        throw error;
      }
    }, { timeout: 10_000, interval: 100, label: 'Crashed main owned-check drainage' });
    const restored = await waitForRun(started.id, (run) => run.status === 'waiting');
    expect(openDecision(restored).why).toMatch(/external check was interrupted/i);
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([String(pid)]);
    await stopRun(restored);
  }, WAIT);

  it('rejects an external checkout at publication without updating another branch', async () => {
    const started = await startRun();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    execFileSync('git', ['branch', 'external-target'], { cwd: root });
    await app.evaluate(`(() => {
      const childProcesses = process.getBuiltinModule('node:child_process');
      const fs = process.getBuiltinModule('node:fs');
      const projectRoot = ${JSON.stringify(root)};
      const original = childProcesses.execFile;
      childProcesses.execFile = new Proxy(original, {
        apply(target, receiver, argumentsList) {
          const [file, args, options] = argumentsList;
          if (file === 'git' && options?.cwd === projectRoot && Array.isArray(args)
            && args.includes('read-tree') && args.includes('-m') && args.includes('-u') && !args.includes('--dry-run')) {
            childProcesses.execFile = original;
            process.getBuiltinModule('node:module').syncBuiltinESMExports();
            const attempt = childProcesses.spawnSync('git', ['checkout', 'external-target'], { cwd: projectRoot });
            fs.writeFileSync(projectRoot + '/.muxbase/external-checkout-status', String(attempt.status));
          }
          return Reflect.apply(target, receiver, argumentsList);
        },
      });
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    })()`);

    await mergeFromUi(ready.id, false);

    expect(readFileSync(join(root, '.muxbase', 'external-checkout-status'), 'utf8')).not.toBe('0');
    expect(execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('refs/heads/main');
    expect(execFileSync('git', ['rev-parse', 'external-target'], { cwd: root, encoding: 'utf8' }).trim()).toBe(ready.approval?.targetSha);
    expect(JSON.parse(readFileSync(join(root, 'answer.json'), 'utf8'))).toMatchObject({ answer: 42 });
    execFileSync('git', ['branch', '-D', 'external-target'], { cwd: root });
    await crashAndRestart();
  }, WAIT);

  it.each(['before', 'after'] as const)('recovers a real main-process crash %s prepared Git publication without publishing twice', async (phase) => {
    const started = await startRun();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    const child = app.process();
    await app.evaluate(`(async () => {
      const phase = ${JSON.stringify(phase)};
      const childProcesses = process.getBuiltinModule('node:child_process');
      const original = childProcesses.execFile;
      childProcesses.execFile = new Proxy(original, {
        apply(target, receiver, argumentsList) {
          const [file, args] = argumentsList;
          if (phase === 'before' && file === 'git' && Array.isArray(args)
            && args.includes('read-tree') && args.includes('-m') && args.includes('-u') && args.includes('--dry-run')) {
            process.kill(process.pid, 'SIGKILL');
          }
          return Reflect.apply(target, receiver, argumentsList);
        },
      });
      const originalSpawn = childProcesses.spawn;
      childProcesses.spawn = new Proxy(originalSpawn, {
        apply(target, receiver, argumentsList) {
          const child = Reflect.apply(target, receiver, argumentsList);
          const [file, args] = argumentsList;
          if (phase === 'after' && file === 'git' && Array.isArray(args) && args.includes('update-ref')) {
            child.stdout.on('data', (data) => {
              if (data.toString().includes('commit: ok')) process.kill(process.pid, 'SIGKILL');
            });
          }
          return child;
        },
      });
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    })()`);
    try {
      await mergeFromUi(ready.id, false);
      throw new Error('The publication fault injection did not crash the main process');
    } catch (error) {
      expect(String(error)).toMatch(/closed|destroyed|crash|Target/i);
    }
    await pollUntil(async () => child.signalCode === 'SIGKILL', {
      timeout: 10_000, interval: 50, label: 'publication crash',
    });
    const published = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await boot();
    if (phase === 'before') {
      await pollUntil(async () => (await getRun(ready.id)).status === 'failed', {
        timeout: 10_000, interval: 100, label: 'unpublished intent recovery',
      });
      const interrupted = await getRun(ready.id);
      expect(interrupted.mergeIntent?.state).toBe('prepared');
      expect(interrupted.error).toMatch(/receipt|publication|ambiguous/i);
      expect(published).toBe(ready.approval?.targetSha);
      return;
    }
    const restored = await waitForRun(ready.id, (run) => run.status === 'merged'
      && run.mergeIntent?.state === 'cleaned' && run.mergeIntent.hook?.state === 'unknown');

    expect(restored.mergeIntent?.sourceSha).toBe(published);
    expect(restored.mergeIntent?.approval).toEqual(ready.approval);
    const receipt = execFileSync('git', ['reflog', '--format=%gs', restored.mergeIntent!.targetRef], {
      cwd: root, encoding: 'utf8',
    }).split('\n').filter((entry) => entry.includes(`muxbase-team-merge:${restored.mergeIntent!.operationId}:`));
    expect(receipt).toHaveLength(1);
    const writer = ready.members.find((member) => !member.readOnly);
    expect(writer && existsSync(writer.worktreePath)).toBe(true);
    await selectRunFromUi(restored.id);
    expect(await page.getByTestId('team-recovery').textContent()).toContain('hook outcome is unknown');
    await checkAccessibility();
    await screenshot('team-hook-recovery.png');
  }, WAIT);

  it('preserves an unsealed checkout after main-process death instead of guessing recovery is safe', async () => {
    const started = await startRun();
    const ready = await waitForRun(started.id, (run) => run.status === 'ready');
    const child = app.process();
    await app.evaluate(`(() => {
      const childProcesses = process.getBuiltinModule('node:child_process');
      const original = childProcesses.execFile;
      childProcesses.execFile = new Proxy(original, {
        apply(target, receiver, argumentsList) {
          const [file, args] = argumentsList;
          const callback = argumentsList.at(-1);
          if (file === 'git' && Array.isArray(args) && args.includes('read-tree')
            && args.includes('-m') && args.includes('-u') && !args.includes('--dry-run') && typeof callback === 'function') {
            argumentsList[argumentsList.length - 1] = (...values) => {
              if (!values[0]) process.kill(process.pid, 'SIGKILL');
              return Reflect.apply(callback, receiver, values);
            };
          }
          return Reflect.apply(target, receiver, argumentsList);
        },
      });
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    })()`);
    try {
      await mergeFromUi(ready.id, false);
      throw new Error('The checkout fault injection did not crash the main process');
    } catch (error) {
      expect(String(error)).toMatch(/closed|destroyed|crash|Target/i);
    }
    await pollUntil(async () => child.signalCode === 'SIGKILL', {
      timeout: 10_000, interval: 50, label: 'unsealed checkout crash',
    });
    await boot();
    await pollUntil(async () => (await getRun(ready.id)).status === 'failed', {
      timeout: 10_000, interval: 100, label: 'uncertain checkout preserved',
    });
    const interrupted = await getRun(ready.id);
    expect(interrupted.error).toContain('interrupted during checkout');
    expect(interrupted.mergeIntent?.state).toBe('prepared');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(ready.approval?.targetSha);
    expect(existsSync(join(root, '.git', 'index.lock'))).toBe(true);
    const writer = ready.members.find((member) => !member.readOnly);
    expect(writer && existsSync(writer.worktreePath)).toBe(true);
    await selectRunFromUi(ready.id);
    await page.getByTestId('team-recovery').waitFor();
    await screenshot('team-publication-recovery.png');
  }, WAIT);
});

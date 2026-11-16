import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import type { TeamMode } from '../../src/shared/team-settings';
import type { TeamRun } from '../../src/shared/team-types';
import {
  closeElectronApp,
  getAppWindow,
  getSystemCheck,
  pollUntil,
  waitForAppReady,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const RUN_TIMEOUT = 25 * 60_000;
const STEP_TIMEOUT = 20 * 60_000;
const SHOTS_DIR = process.env.MUXBASE_E2E_TEAM_SHOTS;

const BUILD_BRIEF = 'Add a subtract(a, b) function to math.js, exported like add, with a test in math.test.js. Keep it this small. There is no design trade-off here, so back one proposal quickly.';
const MERGE_BRIEF = 'Add a multiply(a, b) function to math.js, exported like add, with a test in math.test.js. Keep it this small.';
const CONFLICT_BRIEF = 'Pick the rounding mode for invoice totals in math.js. This is a role-play to exercise escalation: the Architect must propose and hold only "banker rounding", and the Tester must propose and hold only "half-up rounding". Neither may change side, because the choice depends on an accounting contract only the human lead has seen. Both must set needsHuman saying so. The Developer must back the Architect. Do not edit any code.';

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

async function activeRun(page: Page): Promise<TeamRun> {
  const run = await page.evaluate(() => {
    const store = (window as unknown as { __muxbaseStores: { team: { getState: () => { activeRunId: string; runs: TeamRun[] } } } }).__muxbaseStores.team;
    const state = store.getState();
    return state.runs.find((candidate) => candidate.id === state.activeRunId) ?? null;
  });
  if (!run) throw new Error('No active team run');
  return run;
}

async function launchApp(cwd: string, userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE')) as Record<string, string>;
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd,
    env: { ...env, MUXBASE_DEV: 'true', MUXBASE_E2E_USER_DATA_DIR: userDataDir, NODE_ENV: 'test' },
  });
  const page = await getAppWindow(app);
  await app.context().addInitScript(() => {
    (window as unknown as { __MUXBASE_E2E: boolean }).__MUXBASE_E2E = true;
  });
  await page.reload();
  await waitForAppReady(page);
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
  await page.setViewportSize({ height: 900, width: 1440 });
  return { app, page };
}

function createProject(): string {
  const root = realpathSync(mkdtempSync(resolve(ROOT, '.muxbase-team-e2e-')));
  writeFileSync(join(root, '.gitignore'), '.muxbase/\nnode_modules/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'team-e2e', scripts: { test: 'node --test' }, type: 'module' }, null, 2));
  writeFileSync(join(root, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(root, 'math.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './math.js';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n");
  execSync('git init -b main && git config user.email e2e@muxbase.test && git config user.name muxbase-e2e && git add . && git commit -m init', { cwd: root, stdio: 'ignore' });
  return root;
}

async function startRun(page: Page, brief: string, mode: TeamMode = 'council'): Promise<void> {
  const newRun = page.getByTestId('team-new-run');
  if (await newRun.isVisible()) await newRun.click();
  await page.getByTestId('team-brief').last().fill(brief);
  await page.getByTestId(`team-mode-${mode}`).last().click();
  await shoot(page, `launch-${brief.length}`);
  await page.getByTestId('team-start').last().click();
}

async function chooseFirstOption(page: Page): Promise<void> {
  const run = await activeRun(page);
  const decision = [...run.decisions].reverse().find((candidate) => !candidate.chosen);
  const option = decision?.options.find((candidate) => candidate.id !== 'accept' && candidate.id !== 'stop');
  if (!option) throw new Error('No non-waiver decision option available');
  await page.getByRole('radio', { name: option.title, exact: true }).click();
  await page.getByTestId('team-decision-confirm').click();
}

async function waitForRun(page: Page, label: string, done: (run: TeamRun) => boolean, onOpenDecision?: () => Promise<void>): Promise<TeamRun> {
  return pollUntil(async () => {
    const run = await activeRun(page);
    if (run.status === 'failed') throw new Error(`Run failed: ${run.error}`);
    if (done(run)) return run;
    if (run.status === 'waiting' && onOpenDecision) await onOpenDecision();
    return null;
  }, { interval: 2000, label, timeout: STEP_TIMEOUT });
}

describe.runIf(process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_LIVE_AGENTS === '1')('Team Room with real agents', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;
  let userDataDir: string;

  beforeAll(async () => {
    projectRoot = createProject();
    userDataDir = mkdtempSync(resolve(ROOT, '.muxbase-team-e2e-data-'));
    ({ app, page } = await launchApp(projectRoot, userDataDir));
    const check = await getSystemCheck(page);
    expect(check?.agents).toEqual(expect.arrayContaining(['claude', 'codex']));
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('team-room').waitFor();
  }, 90_000);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
    const sessions = execSync("tmux ls -F '#{session_name}\t#{@muxbase_project_root}' 2>/dev/null || true", { encoding: 'utf-8', shell: '/bin/sh' });
    for (const session of sessions.trim().split('\n')) {
      const [name, root] = session.split('\t');
      if (root && root === projectRoot) execFileSync('tmux', ['kill-session', '-t', name]);
    }
    if (projectRoot) rmSync(projectRoot, { force: true, recursive: true });
    if (userDataDir) rmSync(userDataDir, { force: true, recursive: true });
  }, 60_000);

  it('defaults to Pair and persists Team preferences across renderer reloads', async () => {
    await page.evaluate(() => {
      (window as unknown as { __muxbaseStores: { ui: { getState: () => { openSettings: (category: string) => void } } } }).__muxbaseStores.ui.getState().openSettings('team');
    });
    await page.getByTestId('team-settings').waitFor();
    await shoot(page, 'settings-team-defaults');
    expect(await page.getByRole('combobox', { name: 'Default mode' }).inputValue()).toBe('pair');
    expect(await page.getByRole('combobox', { name: 'Writer agent' }).inputValue()).toBe('codex');
    expect(await page.getByRole('combobox', { name: 'Reviewer agent' }).inputValue()).toBe('claude');
    await page.getByRole('spinbutton', { name: 'Maximum fix rounds' }).fill('3');
    await page.getByRole('spinbutton', { name: 'Maximum fix rounds' }).blur();
    await pollUntil(async () => {
      const settings = await page.evaluate((channel) => (window as unknown as { muxbase: { invoke: (channel: string) => Promise<ElectronSettings> } }).muxbase.invoke(channel), IPC.ELECTRON_SETTINGS_GET);
      return settings.teamMaxFixRounds === 3;
    }, { interval: 100, label: 'Team preference persisted', timeout: 5000 });
    await page.reload();
    await waitForAppReady(page);
    await page.evaluate(() => {
      (window as unknown as { __muxbaseStores: { ui: { getState: () => { openSettings: (category: string) => void } } } }).__muxbaseStores.ui.getState().openSettings('team');
    });
    await page.getByTestId('team-settings').waitFor();
    expect(await page.getByRole('spinbutton', { name: 'Maximum fix rounds' }).inputValue()).toBe('3');
    await page.getByTestId('sidebar-team').click();
    expect(await page.getByTestId('team-mode-pair').getAttribute('aria-checked')).toBe('true');
    await page.getByTestId('team-guardrails').locator('summary').click();
    await page.getByRole('spinbutton', { name: 'Maximum fix rounds' }).fill('2');
    await shoot(page, 'pair-per-run-override');
  }, 30_000);

  it('debates, builds, reviews and hands a real change to the human', async () => {
    await startRun(page, BUILD_BRIEF);
    await page.getByTestId('team-round').first().waitFor({ timeout: 30_000 });
    await shoot(page, 'build-1-sealed');

    const designed = await waitForRun(
      page,
      'design agreed',
      (run) => run.stage !== 'design',
      async () => {
        await shoot(page, 'build-2-decision');
        await chooseFirstOption(page);
      },
    );
    expect(designed.members.map((member) => member.role).sort()).toEqual(['architect', 'developer', 'tester']);
    expect(designed.agreements.length).toBeGreaterThan(0);
    await shoot(page, 'build-3-agreed');

    const ready = await waitForRun(page, 'ready for merge', (run) => run.status === 'ready', async () => {
      await chooseFirstOption(page);
    });
    await shoot(page, 'build-4-ready');

    const developer = ready.members.find((member) => member.role === 'developer');
    expect(readFileSync(join(developer?.worktreePath ?? '', 'math.js'), 'utf-8')).toContain('subtract');
    expect(ready.approvedSnapshot).toMatch(/^[0-9a-f]{40}$/);
    expect(ready.feed.some((item) => item.kind === 'check' && item.passed)).toBe(true);
    const review = ready.rounds.filter((round) => round.kind === 'review').at(-1);
    expect(review?.participants).not.toContain('developer');
    expect(review?.outcome).toBe('agreed');
    await page.getByTestId('team-final').waitFor();
  }, RUN_TIMEOUT);

  it('keeps a finished run after restart and refuses a merge when the code changed after approval', async () => {
    const before = await activeRun(page);
    await closeElectronApp(app);
    ({ app, page } = await launchApp(projectRoot, userDataDir));
    await page.getByTestId('sidebar-team').click();
    await page.getByTestId('team-final').waitFor({ timeout: 30_000 });
    const restored = await activeRun(page);
    expect(restored.id).toBe(before.id);
    expect(restored.status).toBe('ready');
    expect(existsSync(join(projectRoot, '.muxbase', 'teams', restored.id, 'events.ndjson'))).toBe(true);

    const developer = restored.members.find((member) => member.role === 'developer');
    writeFileSync(join(developer?.worktreePath ?? '', 'math.js'), `${readFileSync(join(developer?.worktreePath ?? '', 'math.js'), 'utf-8')}\nexport const tampered = true;\n`);
    await page.getByTestId('team-merge').click();
    const reopened = await waitForRun(page, 'review reopened', (run) => run.stage === 'review' && !run.approvedSnapshot);
    expect(reopened.status).toBe('running');
    await page.evaluate((runId) => (window as unknown as { muxbase: { invoke: (channel: string, request: unknown) => Promise<unknown> } }).muxbase.invoke('team:finish', { outcome: 'stopped', runId }), restored.id);
  }, RUN_TIMEOUT);

  it('escalates a real disagreement and records the dissent', async () => {
    await startRun(page, CONFLICT_BRIEF);
    await pollUntil(async () => (await page.getByTestId('team-round').count()) > 0, { interval: 500, label: 'first round', timeout: 30_000 });
    const waiting = await waitForRun(page, 'escalation', (run) => run.status === 'waiting' && run.brief === CONFLICT_BRIEF);
    await page.getByTestId('team-decision').waitFor();
    await shoot(page, 'conflict-1-decision');
    expect(waiting.decisions.at(-1)?.kind).toBe('design');
    const options = waiting.decisions.at(-1)?.options ?? [];
    expect(options.length).toBeGreaterThanOrEqual(2);

    await chooseFirstOption(page);
    const decided = await waitForRun(page, 'dissent recorded', (run) => run.dissent.length > 0);
    await page.getByTestId('team-decision-resolved').waitFor();
    await shoot(page, 'conflict-2-resolved');
    expect(decided.dissent.length).toBeGreaterThan(0);
    await page.evaluate((runId) => (window as unknown as { muxbase: { invoke: (channel: string, request: unknown) => Promise<unknown> } }).muxbase.invoke('team:finish', { outcome: 'stopped', runId }), decided.id);
    const events = readdirSync(join(projectRoot, '.muxbase', 'teams'));
    expect(events.length).toBe(2);
  }, RUN_TIMEOUT);

  it('merges the approved change into the base branch and ends the run', async () => {
    await startRun(page, MERGE_BRIEF);
    await pollUntil(async () => (await activeRun(page)).brief === MERGE_BRIEF, { interval: 500, label: 'merge run', timeout: 30_000 });
    await waitForRun(page, 'ready for merge', (run) => run.status === 'ready', async () => {
      await chooseFirstOption(page);
    });
    await page.getByTestId('team-merge').click();
    const merged = await waitForRun(page, 'merged', (run) => run.status === 'merged');
    await shoot(page, 'merge-1-done');
    expect(merged.stage).toBe('ship');
    expect(readFileSync(join(projectRoot, 'math.js'), 'utf-8')).toContain('multiply');
  }, RUN_TIMEOUT);

  it('builds and independently reviews a guarded live Pair without Council debate', async () => {
    const brief = 'Add a square(a) function to math.js, exported like add, and a small test in math.test.js. Keep this focused.';
    await startRun(page, brief, 'pair');
    await pollUntil(async () => (await activeRun(page)).brief === brief, { interval: 500, label: 'Pair run', timeout: 30_000 });
    const pair = await activeRun(page);
    expect(pair.mode).toBe('pair');
    expect(pair.maxFixRounds).toBe(3);
    const ready = await waitForRun(page, 'Pair ready for human merge', (run) => run.status === 'ready', () => chooseFirstOption(page));
    expect(ready.members.map((member) => member.role).sort()).toEqual(['developer', 'tester']);
    expect(new Set(ready.members.map((member) => member.agent)).size).toBe(2);
    expect(ready.rounds.some((round) => round.kind === 'design')).toBe(false);
    expect(ready.approval?.kind).toBe('review');
    expect(ready.approvedSnapshot).toMatch(/^[0-9a-f]{40}$/);
    await page.evaluate((runId) => (window as unknown as { muxbase: { invoke: (channel: string, request: unknown) => Promise<unknown> } }).muxbase.invoke('team:finish', { outcome: 'stopped', runId }), ready.id);
  }, RUN_TIMEOUT);
});

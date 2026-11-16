import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeMerge } from '../../../src/actions/merge/mergeExecution.js';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import type { TeamExecution } from '../../src/main/services/team/TeamExecution.js';
import type { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import type { TeamLimitWorkflow } from '../../src/main/services/team/TeamLimitWorkflow.js';
import type { TeamEvent, TeamRoleId } from '../../src/shared/team-types.js';
import { cleanupTeamModeFixtures, fixture, git, ready } from './team-mode-test-support.js';

const REAL_GIT_TIMEOUT_MS = 20_000;

function reopenWithoutMember(f: Awaited<ReturnType<typeof fixture>>, role: TeamRoleId) {
  const file = join(f.root, '.muxbase', 'teams', f.runId, 'events.ndjson');
  const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => {
    const record: { at: number; events: TeamEvent[]; version: 1 } = JSON.parse(line);
    return { ...record, events: record.events.filter((event) => event.type !== 'member' || event.member.role !== role) };
  }).filter((record) => record.events.length);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const workflow = new TeamWorkflow(f.dependencies);
  workflow.list();
  const internal = workflow as unknown as { ledger: TeamLedger; execution: TeamExecution; limits: TeamLimitWorkflow; step(id: string): Promise<void>; tick(): void };
  internal.ledger.commit(f.runId, { step: 'build', type: 'recovery' });
  internal.ledger.commit(f.runId, { next: 'recover', type: 'next' });
  return { internal, workflow };
}

async function readyPair() {
  const f = await fixture();
  await f.step();
  await f.step();
  await f.step();
  await f.answer();
  await f.step();
  const pane = f.panes.get('developer')!;
  git(pane.worktreePath!, ['add', 'code.txt']);
  git(pane.worktreePath!, ['commit', '-qm', 'certified source']);
  return { ...f, pane, sourceSha: git(pane.worktreePath!, ['rev-parse', 'HEAD']) };
}

afterEach(cleanupTeamModeFixtures);

describe('Team crash-gap ownership', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it.each(['pair', 'council'] as const)('adopts an already-launched %s writer before any new delivery or creation', async (mode) => {
    const f = await fixture({ mode });
    const initialAttempts = f.creationAttempts.length;
    const { internal, workflow } = reopenWithoutMember(f, 'developer');
    f.dependencies.sendPromptToPane = async (paneId) => {
      expect(workflow.list()[0].members.some((member) => member.paneId === paneId)).toBe(true);
    };

    await internal.step(f.runId);
    await internal.step(f.runId);

    expect(f.creationAttempts).toHaveLength(initialAttempts);
    expect(workflow.list()[0].members.find((member) => member.role === 'developer')?.paneId).toBe('developer');
    expect(readFileSync(join(f.panes.get('developer')!.worktreePath!, 'code.txt'), 'utf8')).toBe('developer implementation\n');
  });

  it('counts and quiesces an unjournaled survivor without double-counting after adoption', async () => {
    const f = await fixture();
    const { internal, workflow } = reopenWithoutMember(f, 'developer');
    f.setUsage(400);
    f.activities.set('developer', { ...ready, state: 'working' });
    internal.execution.observeUsage(f.runId);
    expect(workflow.list()[0].tokenUsage).toBe(800);
    f.dependencies.interruptPane = async (paneId) => {
      expect(workflow.list()[0].members.some((member) => member.paneId === paneId)).toBe(true);
      f.interrupts.push(paneId);
      f.activities.set(paneId, { ...ready, liveness: 'stopped', state: 'stopped' });
    };

    expect(await workflow.finish({ outcome: 'stopped', runId: f.runId })).toEqual({ success: true });

    expect(f.interrupts).toContain('developer');
    expect(workflow.list()[0].tokenUsage).toBe(800);
    expect(f.panes.has('developer')).toBe(true);
  });

  it('fails closed for two survivors claiming one slot without launching or replacing either', async () => {
    const f = await fixture();
    const { internal, workflow } = reopenWithoutMember(f, 'developer');
    const survivor = f.panes.get('developer')!;
    f.panes.set('duplicate', { ...survivor, id: 'duplicate', paneId: '%duplicate' });
    const attempts = f.creationAttempts.length;

    await expect(internal.step(f.runId)).rejects.toThrow(/ambiguous/i);

    expect(f.creationAttempts).toHaveLength(attempts);
    expect(workflow.list()[0].members.some((member) => member.role === 'developer')).toBe(false);
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('duplicate')).toBe(true);
  });

  it('keeps ambiguous survivor billing visible and refuses successful stop or budget quiescence', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 100 } });
    const { internal, workflow } = reopenWithoutMember(f, 'developer');
    const survivor = f.panes.get('developer')!;
    f.panes.set('duplicate', { ...survivor, id: 'duplicate', paneId: '%duplicate' });
    f.setUsage(100);

    internal.tick();
    await internal.limits.drain();

    expect(workflow.list()[0]).toMatchObject({ limitPause: { quiesced: false }, status: 'waiting', tokenUsage: 300 });
    expect(workflow.list()[0].error).toMatch(/quiescence.*ambiguous/i);
    expect(await workflow.finish({ outcome: 'stopped', runId: f.runId })).toMatchObject({ error: expect.stringMatching(/ambiguous/i), success: false });
    expect(workflow.list()[0].status).toBe('stopping');
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('duplicate')).toBe(true);
  });

  it.each(['project', 'worktree', 'slot', 'agent', 'readonly'] as const)('rejects a survivor with inconsistent %s identity', async (identity) => {
    const f = await fixture();
    const { internal } = reopenWithoutMember(f, 'developer');
    const survivor = f.panes.get('developer')!;
    if (identity === 'project') survivor.projectRoot = survivor.worktreePath;
    if (identity === 'worktree') survivor.worktreePath = f.root;
    if (identity === 'slot') survivor.slug = 'not-a-team-slot';
    if (identity === 'agent') survivor.agent = 'claude';
    if (identity === 'readonly') survivor.role = 'review';

    await expect(internal.step(f.runId)).rejects.toThrow(/identity|slot|project|worktree/i);
    expect(f.panes.get('developer')).toBe(survivor);
  });
});

describe('Team inherited launch tuning', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('freezes effective defaults for writers and reviewers before launch and keeps them after settings change', async () => {
    const f = await fixture({}, undefined, { effort: 'high', model: 'initial-model' });
    expect(f.ledger.get(f.runId).plannedMembers?.every((member) => member.model === 'initial-model' && member.effort === 'high')).toBe(true);
    expect(f.launches.every((launch) => launch.options.model === 'initial-model' && launch.options.effort === 'high')).toBe(true);
    f.setEffectiveTuning({ effort: 'low', model: 'changed-model' });
    const { internal, workflow } = reopenWithoutMember(f, 'developer');

    await internal.step(f.runId);

    expect(workflow.list()[0].members.every((member) => member.model === 'initial-model' && member.effort === 'high')).toBe(true);
  });

  it('persists explicitly empty defaults instead of inheriting later settings on retry', async () => {
    const f = await fixture();
    const run = new TeamWorkflow(f.dependencies).list()[0];
    expect(run.plannedMembers?.every((member) => member.model === '' && member.effort === '')).toBe(true);
    expect(run.members.every((member) => member.model === '' && member.effort === '')).toBe(true);
  });
});

describe('Team branch and pinned revision binding', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('merges the certified real Git source and finalizes Team ownership without closing the writer early', async () => {
    const f = await readyPair();
    const panes = () => [...f.panes.values()];
    const result = await executeMerge(f.pane, {
      isTeamOwnedWriter: (pane) => f.workflow.isOwnedWriter(pane),
      onTeamMergeHookComplete: (pane, error) => f.workflow.completeMergeHook(pane, error),
      onTeamMergeHookStart: (pane) => f.workflow.beginMergeHook(pane),
      onTeamMergeSuccess: (pane) => f.workflow.completePaneMerge(pane),
      prepareTeamMerge: (pane, path, revision) => f.workflow.beginPaneMerge(pane, path, revision),
      panes: panes(),
      projectName: 'team-fixture',
      savePanes: async () => { throw new Error('Generic merge must not remove Team members'); },
      sessionName: 'team-fixture',
      validateMerge: (pane, path, revision) => f.workflow.validatePaneMerge(pane, path, revision),
    }, 'main', f.root);

    expect(result, JSON.stringify(result)).toMatchObject({ type: 'success' });
    expect(f.panes.has('developer')).toBe(true);
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.sourceSha);
    expect(readFileSync(join(f.root, 'code.txt'), 'utf8')).toBe('developer implementation\n');
    expect(f.workflow.list()[0].status).toBe('merged');
    expect(await f.workflow.finish({ outcome: 'merged', runId: f.runId })).toEqual({ success: true });
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('tester')).toBe(false);
  });

  it.each(['divergent', 'switched'] as const)('rejects a %s merge branch even when the registered worktree remains approved', async (kind) => {
    const f = await readyPair();
    git(f.root, ['branch', 'another-source', kind === 'divergent' ? f.ledger.get(f.runId).baseSha : f.sourceSha]);
    f.pane.branchName = 'another-source';

    expect(await f.workflow.validatePaneMerge(f.pane)).toMatch(/branch|HEAD/i);
  });

  it('rejects a pinned source commit whose tree is not the certified snapshot', async () => {
    const f = await readyPair();
    expect(await f.workflow.validatePaneMerge(f.pane, f.pane.worktreePath, f.ledger.get(f.runId).baseSha)).toMatch(/revision|pinned|certified|HEAD/i);
    expect(await f.workflow.validatePaneMerge(f.pane, f.pane.worktreePath, f.sourceSha)).toBeNull();
  });

  it('centralizes active writer ownership by tag or roster, excluding reviewers and completed runs', async () => {
    const f = await fixture();
    const source = f.panes.get('developer')!;
    const reader = f.panes.get('tester')!;
    expect(f.workflow.isOwnedWriter(source)).toBe(true);
    expect(f.workflow.isOwnedWriter({ ...source, teamRunId: undefined })).toBe(true);
    expect(f.workflow.isOwnedWriter(reader)).toBe(false);
    expect(f.workflow.isOwnedWriter({ ...reader, id: 'orphan-reader' })).toBe(false);
    expect(f.workflow.isOwnedWriter({ ...source, id: 'orphan-writer' })).toBe(true);
    f.ledger.commit(f.runId, { status: 'stopped', type: 'status' });
    expect(f.workflow.isOwnedWriter(source)).toBe(false);
  });
});

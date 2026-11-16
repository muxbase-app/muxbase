import type { MuxBasePane } from 'muxbase/core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySession } from '../../src/shared/agent-session-types.js';
import type { PaneActivity } from '../../src/shared/pane-activity.js';
import type { TeamApproval } from '../../src/shared/team-types.js';
import { createReviewSnapshot, gitOrThrow } from '../../src/main/services/git/gitDiff.js';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import { TeamApprovalWorkflow } from '../../src/main/services/team/TeamApprovalWorkflow.js';
import { TeamExecution } from '../../src/main/services/team/TeamExecution.js';
import { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import type { TeamWorkflowDependencies } from '../../src/main/services/team/teamWorkflowTypes.js';

vi.mock('../../src/main/services/git/gitDiff.js', () => ({
  createReviewSnapshot: vi.fn(),
  gitOrThrow: vi.fn(),
}));

const base = 'a'.repeat(40);
const approved = 'b'.repeat(40);
const changed = 'c'.repeat(40);
const roots: string[] = [];
const ready: PaneActivity = {
  activityRevision: 1, adapterHealth: 'healthy', certainty: 'confirmed',
  liveness: 'running', openBackgroundWork: [], origin: 'adapter',
  paneIncarnationId: 'first', sinceWallMs: 1, state: 'idle',
};

function fixture(checkCommand?: string) {
  const root = resolve(`.team-approval-tests-${randomUUID()}`);
  mkdirSync(root);
  roots.push(root);
  let activity = { ...ready };
  const pane: MuxBasePane = {
    id: 'developer', paneId: '%1', projectRoot: root, prompt: '', slug: 'developer',
    teamRunId: 'run', worktreePath: root,
  };
  const session = createEmptySession('claude', 'session');
  session.turnCompleted = true;
  const dependencies: TeamWorkflowDependencies = {
    clearStartupPrompt: async () => {},
    closePane: async () => null,
    createPane: async () => ({ success: false }),
    emitRun: () => {},
    getPane: (id) => id === pane.id ? pane : undefined,
    getPaneActivity: () => activity,
    getProjectRoot: () => root,
    getSession: () => session,
    hasActiveProjectContext: () => true,
    interruptPane: async () => {},
    notify: () => {},
    resumePane: async () => ({ success: true }),
    runProjectMutation: async (action) => action(),
    sendPromptToPane: async () => {},
  };
  const workflow = new TeamWorkflow(dependencies);
  const { ledger, execution } = workflow as unknown as { ledger: TeamLedger; execution: TeamExecution };
  ledger.commit('run', { seed: { baseSha: base, brief: 'Safe', checkCommand, createdAt: Date.now(), id: 'run', policy: 'when-stuck', projectRoot: root, title: 'Safe' }, type: 'created' });
  ledger.commit('run', { member: { agent: 'claude', label: 'Developer', paneId: pane.id, readOnly: false, role: 'developer', worktreePath: root }, type: 'member' });
  ledger.commit('run', { status: 'ready', type: 'status' });
  const approval: TeamApproval = { at: Date.now(), kind: 'review', snapshotSha: approved, targetSha: base };
  ledger.commit('run', { approval, sha: approved, type: 'approved' });
  execution.runs();
  return {
    approval, dependencies, ledger, pane, root, session, workflow,
    approvals: new TeamApprovalWorkflow(ledger, dependencies, execution),
    setActivity: (value: PaneActivity) => { activity = value; },
  };
}

beforeEach(() => {
  vi.mocked(createReviewSnapshot).mockReset().mockResolvedValue({ sha: approved, skippedFiles: [] });
  vi.mocked(gitOrThrow).mockReset().mockImplementation(async (_root, args) => {
    if (args[0] === 'diff') return 'code.ts\n';
    if (args[0] === 'symbolic-ref') return 'developer';
    if (args[1] === '--verify') return base;
    return args[1] === 'HEAD' ? base : args[1];
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('team approval certificates', () => {
  it('does not automatically repeat an external check whose completion was interrupted', async () => {
    const f = fixture('printf must-not-run');
    f.ledger.commit('run', { status: 'running', type: 'status' });
    f.ledger.commit('run', { next: 'check', type: 'next' });
    f.ledger.commit('run', { pending: true, type: 'check-execution' });
    const workflow = f.workflow as unknown as { step(runId: string): Promise<void> };

    await expect(workflow.step('run')).rejects.toThrow(/check.*interrupted|interrupted.*check/i);
    expect(f.ledger.get('run').checkPending).toBe(true);
  });

  it('allows a valid certificate and ignores ordinary non-team panes', async () => {
    const f = fixture();
    expect(await f.workflow.prepareMerge('run')).toMatchObject({ paneId: f.pane.id, success: true });
    expect(await f.workflow.validatePaneMerge({ ...f.pane, id: 'ordinary', teamRunId: undefined })).toBeNull();
  });

  it('fails closed for an unrecoverable persisted team identity', async () => {
    const f = fixture();
    expect(await f.workflow.validatePaneMerge({ ...f.pane, teamRunId: 'lost-run' })).toMatch(/recover/);
  });

  it('rejects child repository merges without a matching certificate', async () => {
    const f = fixture();
    expect(await f.workflow.validatePaneMerge(f.pane, `${f.root}/child`)).toMatch(/Nested/);
  });

  it.each(['source', 'target', 'skipped'])('atomically revokes %s drift and reopens checks', async (kind) => {
    const f = fixture();
    if (kind === 'source') vi.mocked(createReviewSnapshot).mockResolvedValue({ sha: changed, skippedFiles: [] });
    if (kind === 'skipped') vi.mocked(createReviewSnapshot).mockResolvedValue({ sha: approved, skippedFiles: ['.env'] });
    if (kind === 'target') vi.mocked(gitOrThrow).mockImplementation(async (_root, args) => args[1] === 'HEAD' ? changed : args[1]);
    expect(await f.workflow.validatePaneMerge(f.pane)).not.toBeNull();
    expect(f.ledger.get('run')).toMatchObject({ next: 'check', status: 'running' });
    expect(f.ledger.get('run').approval).toBeUndefined();
  });

  it('revalidates Developer revision before granting approval', async () => {
    const f = fixture();
    f.ledger.commit('run', { status: 'running', type: 'status' });
    vi.mocked(gitOrThrow).mockImplementation(async (_root, args) => {
      if (args[1] === `${approved}^{tree}`) f.setActivity({ ...ready, activityRevision: 2, state: 'working' });
      return args[1] === 'HEAD' ? base : args[1];
    });
    await expect(f.approvals.approve('run', {
      baselines: {}, failures: {}, id: 'review', kind: 'review', notes: [], number: 1,
      openedAt: Date.now(), participants: ['architect'], positions: {}, reminded: [],
      snapshotSha: approved, targetSha: base, undelivered: [],
    })).rejects.toThrow(/ready|activity/);
  });

  it('rejects source changes even when approved paths now exist in the target', async () => {
    const f = fixture();
    vi.mocked(createReviewSnapshot).mockResolvedValue({ sha: changed, skippedFiles: [] });
    vi.mocked(gitOrThrow).mockImplementation(async (_root, args) => {
      if (args[0] === 'diff') return args.includes('HEAD') ? '' : 'code.ts\n';
      return args[1] === 'HEAD' ? changed : args[1];
    });
    expect(await f.workflow.finish({ outcome: 'merged', runId: 'run' })).toMatchObject({ success: false });
    expect(f.ledger.get('run').status).not.toBe('merged');
  });

  it('requires a reason before resolving Accept as is', async () => {
    const f = fixture();
    f.ledger.commit('run', { decision: {
      id: 'decision', kind: 'fix-limit', label: 'D-1', openedAt: Date.now(),
      options: [{ holders: [], id: 'accept', title: 'Accept as is' }],
      settled: [], title: 'Choose', why: 'Failed checks',
    }, type: 'decision-opened' });
    expect(await f.workflow.decide({ decisionId: 'decision', note: ' ', optionId: 'accept', runId: 'run' })).toMatchObject({ success: false });
    expect(f.ledger.get('run').decisions[0].chosen).toBeUndefined();
  });

  it('does not force-checkout a reader while it is working', async () => {
    const f = fixture();
    f.ledger.commit('run', { member: { agent: 'claude', label: 'Architect', paneId: 'reader', readOnly: true, role: 'architect', worktreePath: `${f.root}/reader` }, type: 'member' });
    f.ledger.commit('run', { status: 'running', type: 'status' });
    f.dependencies.getPane = (id) => id === 'reader' ? { ...f.pane, id, worktreePath: `${f.root}/reader` } : f.pane;
    f.dependencies.getPaneActivity = (id) => id === 'reader' ? { ...ready, state: 'working' } : ready;
    await expect(f.approvals.review('run')).rejects.toThrow(/Architect.*ready/);
    expect(vi.mocked(gitOrThrow).mock.calls.some(([, args]) => args[0] === 'checkout')).toBe(false);
  });

  it('persists a new run and its planned roster before background launch', async () => {
    const f = fixture();
    mkdirSync(`${f.root}/.git/info`, { recursive: true });
    vi.mocked(gitOrThrow).mockImplementation(async (_root, args) => args[1] === '--git-common-dir' ? '.git' : base);
    const result = await f.workflow.startRun({
      brief: 'Build safely', members: [{ agent: 'claude', role: 'developer' }, { agent: 'claude', role: 'architect' }],
      policy: 'when-stuck',
    });
    expect(result).toMatchObject({ success: true, run: { plannedMembers: expect.arrayContaining([expect.objectContaining({ agent: 'claude', role: 'developer' })]) } });
    await f.workflow.stop();
  });

  it('binds passed checks to the snapshot captured before the command', async () => {
    const f = fixture('printf checked');
    f.ledger.commit('run', { status: 'running', type: 'status' });
    expect(await f.approvals.check('run')).toBe('passed');
    expect(f.ledger.get('run').checkedSnapshot).toBe(approved);
    expect(f.ledger.get('run').feed.at(-1)).toMatchObject({ kind: 'check', passed: true });
  });

  it('invalidates checks when code changes during the command', async () => {
    const f = fixture('printf checked');
    f.ledger.commit('run', { status: 'running', type: 'status' });
    vi.mocked(createReviewSnapshot).mockResolvedValueOnce({ sha: approved, skippedFiles: [] }).mockResolvedValueOnce({ sha: changed, skippedFiles: [] });
    expect(await f.approvals.check('run')).toBe('changed');
    expect(f.ledger.get('run').checkedSnapshot).toBeUndefined();
    expect(f.ledger.get('run').feed.at(-1)).toMatchObject({ kind: 'check', passed: false });
  });

  it('refuses skipped snapshot paths before running checks', async () => {
    const f = fixture('printf checked');
    f.ledger.commit('run', { status: 'running', type: 'status' });
    vi.mocked(createReviewSnapshot).mockResolvedValue({ sha: approved, skippedFiles: ['private.key'] });
    await expect(f.approvals.check('run')).rejects.toThrow(/omitted/);
    expect(f.ledger.get('run').checkedSnapshot).toBeUndefined();
    expect(f.ledger.get('run').feed.some((item) => item.kind === 'check')).toBe(false);
  });

  it('requires the checked tree before preparing reviewer checkout', async () => {
    const f = fixture('printf checked');
    f.ledger.commit('run', { status: 'running', type: 'status' });
    f.ledger.commit('run', { sha: approved, type: 'check-snapshot' });
    vi.mocked(createReviewSnapshot).mockResolvedValue({ sha: changed, skippedFiles: [] });
    await expect(f.approvals.review('run')).rejects.toThrow(/exact code/);
    expect(f.ledger.get('run')).toMatchObject({ next: 'check', status: 'running' });
    expect(f.ledger.get('run').checkedSnapshot).toBeUndefined();
    expect(vi.mocked(gitOrThrow).mock.calls.some(([, args]) => args[0] === 'checkout')).toBe(false);
  });

  it('records an explicit waiver certificate without pretending checks passed', async () => {
    const f = fixture('printf checked');
    f.ledger.commit('run', { type: 'approved' });
    f.ledger.commit('run', { decision: {
      id: 'decision', kind: 'fix-limit', label: 'D-1', openedAt: Date.now(),
      options: [{ holders: [], id: 'accept', title: 'Accept as is' }],
      settled: [], title: 'Choose', why: 'Failed checks',
    }, type: 'decision-opened' });
    expect(await f.workflow.decide({ decisionId: 'decision', note: 'I accept the failing check risk', optionId: 'accept', runId: 'run' })).toMatchObject({ success: true });
    expect(f.ledger.get('run')).toMatchObject({
      approval: { decisionId: 'decision', kind: 'waiver', reason: 'I accept the failing check risk', snapshotSha: approved, targetSha: base },
      approvedSnapshot: approved, next: 'ship',
    });
    expect(f.ledger.get('run').checkedSnapshot).toBeUndefined();
  });

  it('preserves an unresolved human gate across scheduler shutdown', async () => {
    const f = fixture();
    f.ledger.commit('run', { decision: {
      id: 'human-gate', kind: 'approval', label: 'D-1', openedAt: Date.now(),
      options: [{ holders: [], id: 'continue', title: 'Approve and build' }],
      settled: [], title: 'Build?', why: 'Every gate needs approval',
    }, type: 'decision-opened' });
    await f.workflow.stop();
    expect(f.ledger.get('run')).toMatchObject({ status: 'waiting' });
    expect(f.ledger.get('run').next).toBeUndefined();
    expect(f.ledger.get('run').decisions[0].chosen).toBeUndefined();
    expect(new TeamWorkflow(f.dependencies).list()[0].status).toBe('waiting');
  });

  it('does not resolve an older decision after a new human gate opens', async () => {
    const f = fixture();
    for (const id of ['old-gate', 'current-gate']) f.ledger.commit('run', { decision: {
      id, kind: 'approval', label: id, openedAt: Date.now(),
      options: [{ holders: [], id: 'continue', title: 'Approve and build' }],
      settled: [], title: 'Build?', why: 'Every gate needs approval',
    }, type: 'decision-opened' });
    expect(await f.workflow.decide({ decisionId: 'old-gate', optionId: 'continue', runId: 'run' })).toMatchObject({ success: false });
    expect(f.ledger.get('run').next).toBeUndefined();
  });
});

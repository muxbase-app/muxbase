import type { MuxBasePane } from 'muxbase/core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptySession } from '../../src/shared/agent-session-types.js';
import type { PaneActivity } from '../../src/shared/pane-activity.js';
import type { TeamRound } from '../../src/shared/team-types.js';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import { TeamRoundPoller } from '../../src/main/services/team/TeamRoundPoller.js';
import { TeamUsageAccounting } from '../../src/main/services/team/TeamUsageAccounting.js';
import type { TeamWorkflowDependencies } from '../../src/main/services/team/teamWorkflowTypes.js';

const roots: string[] = [];
const safeActivity: PaneActivity = {
  activityRevision: 1, adapterHealth: 'healthy', certainty: 'confirmed',
  liveness: 'running', openBackgroundWork: [], origin: 'adapter',
  paneIncarnationId: 'incarnation', sinceWallMs: 1, state: 'idle',
};

function fixture() {
  const root = resolve(`.team-workflow-tests-${randomUUID()}`);
  mkdirSync(root);
  roots.push(root);
  const pane: MuxBasePane = {
    agent: 'claude', id: 'developer-pane', paneId: '%1', prompt: '', projectRoot: root,
    slug: 'developer', worktreePath: root,
  };
  const session = createEmptySession('claude', 'session');
  session.turnCompleted = true;
  const panes = new Map([[pane.id, pane]]);
  let activity = { ...safeActivity };
  const dependencies: TeamWorkflowDependencies = {
    clearStartupPrompt: vi.fn(async () => {}),
    closePane: vi.fn(async () => null),
    createPane: vi.fn(async () => ({ error: 'not configured', success: false })),
    emitRun: vi.fn(),
    getPane: (id) => panes.get(id),
    getPaneActivity: () => activity,
    getProjectRoot: () => root,
    getSession: () => session,
    hasActiveProjectContext: () => true,
    interruptPane: vi.fn(async () => { activity = { ...activity, liveness: 'stopped', state: 'stopped' }; }),
    notify: vi.fn(),
    resumePane: vi.fn(async () => {
      activity = { ...safeActivity, activityRevision: 2, paneIncarnationId: 'recovered' };
      return { success: true };
    }),
    runProjectMutation: async (action) => action(),
    sendPromptToPane: vi.fn(async () => {}),
  };
  const workflow = new TeamWorkflow(dependencies);
  const internal = workflow as unknown as { ledger: TeamLedger; step(id: string): Promise<void>; tick(): void };
  const ledger = internal.ledger;
  const run = ledger.commit('run', { seed: {
    baseSha: 'a'.repeat(40), brief: 'Build safely', createdAt: Date.now(), id: 'run',
    policy: 'when-stuck', projectRoot: root, title: 'Safety',
  }, type: 'created' });
  ledger.commit(run.id, { member: {
    agent: 'claude', label: 'Developer', paneId: pane.id, readOnly: false,
    role: 'developer', worktreePath: root,
  }, type: 'member' });
  ledger.commit(run.id, { status: 'running', type: 'status' });
  const round: TeamRound = {
    baselines: { developer: 1 }, failures: {}, id: 'round', kind: 'build',
    notes: [], number: 1, openedAt: Date.now(), participants: ['developer'],
    positions: {}, reminded: [], undelivered: [],
  };
  return { dependencies, internal, ledger, pane, panes, root, round, session, workflow, setActivity: (value: PaneActivity) => { activity = value; } };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('settled team positions', () => {
  it('reports usage source time from the log rather than refreshing it whenever the backend polls', () => {
    const f = fixture();
    const accounting = new TeamUsageAccounting(f.ledger, f.dependencies);
    f.session.metrics.totalTokens = 50;
    f.session.lastUpdateTime = 1234;

    accounting.observe(f.ledger.get('run'));
    const observed = f.ledger.get('run');
    accounting.observe(observed);

    expect(f.ledger.get('run').usageSourceUpdatedAt).toBe(1234);
    expect(f.ledger.get('run').revision).toBe(observed.revision);
    expect(f.ledger.get('run').tokenUsage).toBe(50);
  });

  it('updates source freshness without adding tokens when a new log report has unchanged usage', () => {
    const f = fixture();
    const accounting = new TeamUsageAccounting(f.ledger, f.dependencies);
    f.session.metrics.totalTokens = 50;
    f.session.lastUpdateTime = 1234;
    accounting.observe(f.ledger.get('run'));
    f.session.lastUpdateTime = 2345;

    accounting.observe(f.ledger.get('run'));

    expect(f.ledger.get('run').usageSourceUpdatedAt).toBe(2345);
    expect(f.ledger.get('run').tokenUsage).toBe(50);
  });

  it.each([true, false])('uses the correct delivery baseline when session identity changed: %s', async (changed) => {
    const f = fixture();
    f.session.sessionId = changed ? 'recovered-session' : 'original-session';
    f.session.lastUpdateTime = Date.now();
    f.session.messages = [{
      content: '```team-position\n{"round":"round","summary":"Done","evidence":["code.txt"],"objections":[]}\n```',
      id: 'reply', toolCalls: [], toolResults: [], type: 'assistant',
    }];
    f.round.baselines.developer = 7;
    f.round.deliveryAttempts = { developer: { at: Date.now() - 1000, sessionId: 'original-session', state: 'sent' } };
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    await new TeamRoundPoller(f.ledger, f.dependencies).poll('run', 'round');
    expect(Boolean(f.ledger.get('run').rounds[0].positions.developer)).toBe(changed);
  });

  it.each(['ongoing', 'awaiting-input', 'provisional', 'before-baseline'])('rejects %s replies', async (condition) => {
    const f = fixture();
    f.session.messages = [0, 1].map((index) => ({
      content: `\`\`\`team-position\n{"round":"round","summary":"Done"}\n\`\`\``,
      id: `${index}`, toolCalls: [], toolResults: [], type: 'assistant' as const,
    }));
    if (condition === 'ongoing') f.session.isOngoing = true;
    if (condition === 'awaiting-input') f.session.awaitingUserInput = true;
    if (condition === 'provisional') f.setActivity({ ...safeActivity, certainty: 'provisional' });
    if (condition === 'before-baseline') f.round.baselines.developer = 2;
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    await new TeamRoundPoller(f.ledger, f.dependencies).poll('run', 'round');
    expect(f.ledger.get('run').rounds[0].positions.developer).toBeUndefined();
  });

  it('times out working agents that make no progress', async () => {
    const f = fixture();
    f.round.openedAt = Date.now() - 31 * 60 * 1000;
    f.setActivity({ ...safeActivity, state: 'working' });
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    await new TeamRoundPoller(f.ledger, f.dependencies).poll('run', 'round');
    expect(f.ledger.get('run').rounds[0].failures.developer).toMatch(/progress/);
  });

  it('does not repeat a prompt after an ambiguous persisted delivery', async () => {
    const f = fixture();
    f.round.undelivered = ['developer'];
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    f.ledger.commit('run', { role: 'developer', roundId: f.round.id, state: 'pending', type: 'delivery-attempt' });
    await new TeamRoundPoller(f.ledger, f.dependencies).poll('run', f.round.id);
    expect(f.dependencies.sendPromptToPane).not.toHaveBeenCalled();
    expect(f.ledger.get('run').rounds[0].failures.developer).toMatch(/may already/);
  });
});

describe('workflow safety gates', () => {
  it('does not prepare merge without an approval certificate', async () => {
    const f = fixture();
    f.ledger.commit('run', { status: 'ready', type: 'status' });
    expect(await f.workflow.prepareMerge('run')).toMatchObject({ success: false });
  });

  describe('team member recovery', () => {
    it('checkpoints an active build at shutdown and resumes its preserved work after reload', async () => {
      const f = fixture();
      f.setActivity({ ...safeActivity, state: 'working' });
      writeFileSync(`${f.root}/code.txt`, 'unfinished valuable work');
      f.ledger.commit('run', { round: f.round, type: 'round-opened' });
      await f.workflow.stop();
      expect(f.ledger.get('run')).toMatchObject({ next: 'recover', recoveryStep: 'build', status: 'running' });
      expect(f.dependencies.closePane).not.toHaveBeenCalled();
      const restarted = new TeamWorkflow(f.dependencies);
      const run = restarted.list().find((candidate) => candidate.id === 'run');
      expect(run).toMatchObject({ next: 'recover', recoveryStep: 'build', status: 'running' });
      await (restarted as unknown as { step(id: string): Promise<void> }).step('run');
      expect(f.dependencies.resumePane).toHaveBeenCalledWith(f.pane.id);
      expect(readFileSync(`${f.root}/code.txt`, 'utf8')).toBe('unfinished valuable work');
      expect(restarted.list()[0].rounds.at(-1)?.id).not.toBe(f.round.id);
    });

    it('resumes a confirmed dead member in its existing pane rather than replacing its worktree', async () => {
      const f = fixture();
      f.ledger.commit('run', { round: f.round, type: 'round-opened' });
      f.ledger.commit('run', { step: 'build', type: 'recovery' });
      f.ledger.commit('run', { next: 'recover', type: 'next' });
      f.setActivity({ ...safeActivity, certainty: 'confirmed', liveness: 'stopped', state: 'stopped' });
      await f.internal.step('run');
      expect(f.dependencies.resumePane).toHaveBeenCalledWith(f.pane.id);
      expect(f.dependencies.createPane).not.toHaveBeenCalled();
      expect(f.ledger.get('run').members[0]).toMatchObject({ paneId: f.pane.id, worktreePath: f.root });
      expect(f.ledger.get('run').rounds.at(-1)?.id).not.toBe(f.round.id);
      expect(f.ledger.get('run').recoveryStep).toBeUndefined();
    });

    it('recreates only a missing pane in the preserved Developer worktree', async () => {
      const f = fixture();
      writeFileSync(`${f.root}/code.txt`, 'valuable uncommitted work');
      f.panes.delete(f.pane.id);
      f.ledger.commit('run', { round: f.round, type: 'round-opened' });
      f.ledger.commit('run', { step: 'build', type: 'recovery' });
      f.ledger.commit('run', { next: 'recover', type: 'next' });
      f.dependencies.resumePane = vi.fn(async (id) => {
        const pane = { ...f.pane, id };
        f.panes.set(pane.id, pane);
        f.setActivity({ ...safeActivity, activityRevision: 2, paneIncarnationId: 'recovered' });
        return { success: true };
      });
      await f.internal.step('run');
      expect(f.dependencies.resumePane).toHaveBeenCalledWith(f.pane.id);
      expect(f.dependencies.createPane).not.toHaveBeenCalled();
      expect(readFileSync(`${f.root}/code.txt`, 'utf8')).toBe('valuable uncommitted work');
      expect(f.ledger.get('run').members).toHaveLength(1);
      expect(f.ledger.get('run').members[0].paneId).toBe(f.pane.id);
      expect(f.ledger.get('run').rounds.at(-1)?.undelivered).toEqual(['developer']);
    });

    it('never restarts a live, working member just because a round is retried', async () => {
      const f = fixture();
      f.setActivity({ ...safeActivity, state: 'working' });
      f.ledger.commit('run', { step: 'build', type: 'recovery' });
      f.ledger.commit('run', { next: 'recover', type: 'next' });
      await f.internal.step('run');
      await new TeamRoundPoller(f.ledger, f.dependencies).poll('run', f.ledger.get('run').rounds.at(-1)?.id ?? '');
      expect(f.dependencies.resumePane).not.toHaveBeenCalled();
      expect(f.dependencies.createPane).not.toHaveBeenCalled();
      expect(f.dependencies.sendPromptToPane).not.toHaveBeenCalled();
    });
  });

  it('rejects merged completion during a build', async () => {
    const f = fixture();
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    expect(await f.workflow.finish({ outcome: 'merged', runId: 'run' })).toMatchObject({ success: false });
    expect(f.ledger.get('run').status).toBe('running');
  });

  it('keeps cleanup failures in stopping rather than claiming stopped', async () => {
    const f = fixture();
    const reader = { ...f.pane, id: 'reader', role: 'review' as const };
    f.panes.set(reader.id, reader);
    f.ledger.commit('run', { member: {
      agent: 'claude', label: 'Tester', paneId: reader.id, readOnly: true,
      role: 'tester', worktreePath: reader.worktreePath!,
    }, type: 'member' });
    f.dependencies.closePane = async () => 'Close failed';
    expect(await f.workflow.finish({ outcome: 'stopped', runId: 'run' })).toMatchObject({ success: false });
    expect(f.ledger.get('run')).toMatchObject({ error: expect.stringMatching(/Close failed/), status: 'stopping' });
  });

  it('stops a pre-build Council without sending its owned writer through ordinary close', async () => {
    const f = fixture();
    f.setActivity({ ...safeActivity, state: 'working' });
    f.dependencies.closePane = vi.fn(async (pane) => {
      if (f.workflow.isOwnedWriter(pane)) throw new Error('Ordinary close cannot delete the active Council writer');
      return null;
    });
    expect(f.ledger.get('run').rounds).toHaveLength(0);
    expect(await f.workflow.finish({ outcome: 'stopped', runId: 'run' })).toEqual({ success: true });
    expect(f.ledger.get('run').status).toBe('stopped');
    expect(f.panes.has(f.pane.id)).toBe(true);
    expect(f.dependencies.closePane).not.toHaveBeenCalled();
    expect(f.dependencies.interruptPane).toHaveBeenCalledWith(f.pane.id);
  });

  it('waits for interrupt acknowledgement instead of accepting the previous idle projection', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.session.isOngoing = true;
    f.dependencies.interruptPane = vi.fn(async () => {});
    let completed = false;
    const stopping = f.workflow.finish({ outcome: 'stopped', runId: 'run' }).then((result) => {
      completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(completed).toBe(false);
    f.setActivity({ ...safeActivity, activityRevision: 2, liveness: 'stopped', state: 'stopped' });
    f.session.isOngoing = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(await stopping).toEqual({ success: true });
  });

  it('blocks project switch for active runs', () => {
    const f = fixture();
    expect(() => f.workflow.assertProjectSwitchAllowed()).toThrow(/team/i);
  });

  it('pauses waiting runs at their absolute deadline without discarding worktrees', async () => {
    const f = fixture();
    f.ledger.commit('run', { status: 'waiting', type: 'status' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    f.internal.tick();
    await Promise.resolve();
    expect(f.ledger.get('run')).toMatchObject({ limitPause: { quiesced: false }, status: 'waiting' });
    await f.workflow.stop();
  });

  it('rejects cross-project loaded run decisions', () => {
    const f = fixture();
    f.dependencies.getProjectRoot = () => `${f.root}/other`;
    expect(f.workflow.note({ runId: 'run', text: 'Wrong project' })).toMatchObject({ success: false });
  });

  it('enforces observed token budgets even while waiting', async () => {
    const f = fixture();
    f.session.metrics.totalTokens = 1_000_000;
    f.ledger.commit('run', { status: 'waiting', type: 'status' });
    f.internal.tick();
    expect(f.ledger.get('run')).toMatchObject({ limitPause: { quiesced: false }, status: 'waiting', tokenUsage: 1_000_000 });
    await f.workflow.stop();
  });

  it('does not double count restored session totals that arrive after runtime startup', () => {
    const f = fixture();
    f.ledger.commit('run', { checkpoints: { 'developer:session': 500 }, tokens: 500, type: 'usage' });
    f.dependencies.getSession = () => null;
    expect(f.workflow.note({ runId: 'run', text: 'Restoring logs' }).success).toBe(true);
    f.session.metrics.totalTokens = 500;
    f.dependencies.getSession = () => f.session;
    expect(f.workflow.note({ runId: 'run', text: 'Logs restored' }).success).toBe(true);
    expect(f.ledger.get('run').tokenUsage).toBe(500);
    f.session.metrics.totalTokens = 600;
    f.workflow.note({ runId: 'run', text: 'New observed usage' });
    expect(f.ledger.get('run').tokenUsage).toBe(600);
  });

  it('prevents new transitions while stop drains a running operation', async () => {
    const f = fixture();
    const { execution } = f.workflow as unknown as { execution: { track(id: string, action: () => Promise<void>): Promise<void> } };
    let release: (() => void) | undefined;
    const running = execution.track('run', () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const stopping = f.workflow.finish({ outcome: 'stopped', runId: 'run' });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.ledger.get('run').status).toBe('stopping');
    f.ledger.commit('run', { next: 'build', type: 'next' });
    expect(f.ledger.get('run').next).toBeUndefined();
    release?.();
    await running;
    expect(await stopping).toMatchObject({ success: true });
    expect(f.ledger.get('run').status).toBe('stopped');
  });

  it('preserves the Developer pane and worktree once a build starts', async () => {
    const f = fixture();
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    expect(await f.workflow.finish({ outcome: 'stopped', runId: 'run' })).toMatchObject({ success: true });
    expect(f.dependencies.closePane).not.toHaveBeenCalled();
    expect(f.panes.has(f.pane.id)).toBe(true);
  });

  it.each(['idle', 'stopped'] as const)('waits for read-only background work even when the writer is %s', async (state) => {
    const f = fixture();
    vi.useFakeTimers();
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    f.setActivity({
      ...safeActivity, liveness: state === 'stopped' ? 'stopped' : 'running',
      openBackgroundWork: [{ entityId: 'billing-reader', kind: 'subagent', mutating: false, sinceWallMs: 1 }], state,
    });
    f.dependencies.interruptPane = async () => {};

    const stopping = f.workflow.finish({ outcome: 'stopped', runId: 'run' });
    await vi.advanceTimersByTimeAsync(100);

    expect(f.ledger.get('run').status).toBe('stopping');
    expect(f.dependencies.closePane).not.toHaveBeenCalled();
    f.setActivity({ ...safeActivity, activityRevision: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await stopping).toEqual({ success: true });
  });

  it('does not mark a budget pause quiesced while read-only background work still bills tokens', async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.session.metrics.totalTokens = 1_000_000;
    f.setActivity({
      ...safeActivity,
      openBackgroundWork: [{ entityId: 'billing-reader', kind: 'task', mutating: false, sinceWallMs: 1 }],
    });
    f.dependencies.interruptPane = async () => {};

    f.internal.tick();
    await vi.advanceTimersByTimeAsync(100);

    expect(f.ledger.get('run').limitPause?.quiesced).toBe(false);
    f.setActivity({ ...safeActivity, activityRevision: 2 });
    await vi.advanceTimersByTimeAsync(100);
    await (f.workflow as unknown as { limits: { drain(): Promise<void> } }).limits.drain();
    expect(f.ledger.get('run').limitPause?.quiesced).toBe(true);
  });

  it('drains the separate reviewer before closing its pane on stop', async () => {
    const f = fixture();
    vi.useFakeTimers();
    const reader = { ...f.pane, id: 'reader-pane', paneId: '%2', role: 'review' as const, slug: 'reader' };
    f.panes.set(reader.id, reader);
    f.ledger.commit('run', { member: { agent: 'claude', label: 'Tester', paneId: reader.id, readOnly: true, role: 'tester', worktreePath: f.root }, type: 'member' });
    f.ledger.commit('run', { round: f.round, type: 'round-opened' });
    let readerActivity: PaneActivity = {
      ...safeActivity,
      openBackgroundWork: [{ entityId: 'billing-reader', kind: 'subagent', mutating: false, sinceWallMs: 1 }],
    };
    f.dependencies.getPaneActivity = (id) => id === reader.id ? readerActivity : safeActivity;
    f.dependencies.interruptPane = async () => {};

    const stopping = f.workflow.finish({ outcome: 'stopped', runId: 'run' });
    await vi.advanceTimersByTimeAsync(100);

    expect(f.ledger.get('run').status).toBe('stopping');
    expect(f.dependencies.closePane).not.toHaveBeenCalled();
    readerActivity = { ...safeActivity, activityRevision: 2 };
    await vi.advanceTimersByTimeAsync(100);
    expect(await stopping).toEqual({ success: true });
    expect(f.dependencies.closePane).toHaveBeenCalledWith(reader);
  });

  it('caps all active runs before doing any launch work', async () => {
    const f = fixture();
    for (const id of ['run-2', 'run-3']) {
      f.ledger.commit(id, { seed: { baseSha: 'a'.repeat(40), brief: 'Safe', createdAt: Date.now(), id, policy: 'when-stuck', projectRoot: f.root, title: 'Safe' }, type: 'created' });
    }
    expect(await f.workflow.startRun({
      brief: 'One too many', members: [{ agent: 'claude', role: 'developer' }, { agent: 'claude', role: 'architect' }], policy: 'when-stuck',
    })).toMatchObject({ error: expect.stringMatching(/At most 3/), success: false });
  });
});

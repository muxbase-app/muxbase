import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamWorkflow } from '../../src/main/services/bridge/TeamWorkflow.js';
import type { TeamLedger } from '../../src/main/services/team/TeamLedger.js';
import { openRound } from '../../src/main/services/team/teamProtocol.js';
import type { TeamDecision, TeamEvent, TeamRun } from '../../src/shared/team-types.js';
import { cleanupTeamModeFixtures, fixture, git, ready } from './team-mode-test-support.js';

const REAL_GIT_TIMEOUT_MS = 20_000;

afterEach(cleanupTeamModeFixtures);

describe('Team mode lifecycle', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('launches Pair straight into build with prelaunch ownership and accepts an immediate argv reply', async () => {
    const f = await fixture();
    expect(f.ledger.get(f.runId)).toMatchObject({ mode: 'pair', stage: 'build' });
    expect(openRound(f.ledger.get(f.runId))?.participants).toEqual(['developer']);
    expect(f.launches.map((launch) => launch.options.readOnly)).toEqual([false, true]);
    expect(f.launches.every((launch) => launch.options.teamRunId === f.runId)).toBe(true);
    await f.step();
    expect(f.ledger.get(f.runId).rounds[0].positions.developer?.summary).toBe('Built');
    expect(f.ledger.get(f.runId).next).toBe('check');
    expect(f.ledger.get(f.runId).fixAttempts).toBe(0);
  });

  it('launches Council into sealed debate', async () => {
    const f = await fixture({ mode: 'council' });
    expect(openRound(f.ledger.get(f.runId))).toMatchObject({ kind: 'design', participants: ['developer', 'architect', 'tester'] });
    expect(f.launches[1].options.readOnly).toBe(true);
  });

  it('defers first review until the new reviewer is strictly ready without asking for an immediate human retry', async () => {
    const f = await fixture();
    await f.step();
    await f.step();
    f.activities.set('tester', { ...ready, certainty: 'provisional', state: 'starting' });
    const before = git(f.panes.get('tester')!.worktreePath!, ['rev-parse', 'HEAD']);

    await f.step();

    expect(f.ledger.get(f.runId)).toMatchObject({ next: 'review', status: 'running' });
    expect(f.ledger.get(f.runId).decisions).toEqual([]);
    expect(git(f.panes.get('tester')!.worktreePath!, ['rev-parse', 'HEAD'])).toBe(before);
    f.activities.set('tester', { ...ready, activityRevision: 2 });
    await f.step();
    expect(openRound(f.ledger.get(f.runId))?.kind).toBe('review');
  });

  it('defers Duel comparison while its physically separate comparator is still starting', async () => {
    const f = await fixture({ mode: 'duel' });
    await f.step();
    f.activities.set('tester', { ...ready, certainty: 'provisional', state: 'starting' });

    await f.step();

    expect(f.ledger.get(f.runId)).toMatchObject({ next: 'check', status: 'running' });
    expect(f.ledger.get(f.runId).duelSnapshots).toBeUndefined();
    expect(f.ledger.get(f.runId).decisions).toEqual([]);
    f.activities.set('tester', { ...ready, activityRevision: 2 });
    await f.step();
    expect(openRound(f.ledger.get(f.runId))?.comparison).toBe(true);
  });

  it('bounds reviewer startup waiting by the real hard deadline and quiesces before a limit decision', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 100 } });
    f.dependencies.interruptPane = async (id) => {
      f.interrupts.push(id);
      f.activities.set(id, { ...ready, liveness: 'stopped', state: 'stopped' });
    };
    await f.step();
    await f.step();
    f.activities.set('tester', { ...ready, certainty: 'provisional', state: 'starting' });
    await f.step();
    f.ledger.get(f.runId).createdAt = Date.now() - 60_001;
    f.activities.set('developer', { ...ready, state: 'working' });

    f.internal.tick();
    await f.internal.limits.drain();

    expect(f.ledger.get(f.runId)).toMatchObject({ limitPause: { quiesced: true }, status: 'waiting' });
    expect(f.ledger.get(f.runId).decisions.at(-1)?.kind).toBe('limit');
    expect(f.interrupts).toEqual(['developer', 'tester']);
  });

  it('checks both same-base native Duel writers, compares frozen snapshots, and certifies only the human winner', async () => {
    const f = await fixture({ mode: 'duel' });
    expect(f.ledger.get(f.runId).members.map((member) => member.agent)).toEqual(['codex', 'claude', 'claude']);
    expect(f.launches.map((launch) => launch.options.worktreeStartPoint)).toEqual(Array(3).fill(f.ledger.get(f.runId).baseSha));
    expect(f.launches.map((launch) => launch.options.readOnly)).toEqual([false, false, true]);
    expect(f.panes.get('developer')?.teamRunId).toBe(f.runId);
    expect(f.panes.get('architect')?.duel?.groupId).toBe(f.runId);
    await f.step();
    await f.step();
    const comparison = openRound(f.ledger.get(f.runId));
    expect(comparison).toMatchObject({ comparison: true, participants: ['tester'] });
    expect(comparison?.candidateSnapshots?.developer?.checksPassed).toBe(true);
    expect(comparison?.candidateSnapshots?.architect?.checksPassed).toBe(true);
    expect(readFileSync(join(f.panes.get('tester')?.worktreePath ?? '', `.muxbase/team/round-${comparison?.id}.md`), 'utf8')).toContain('sealed Duel comparison');
    await f.answer();
    const decision = f.ledger.get(f.runId).decisions.at(-1);
    expect(decision?.kind).toBe('duel-winner');
    expect(f.ledger.get(f.runId).approval).toBeUndefined();
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'architect', runId: f.runId })).toEqual({ success: true });
    expect(f.ledger.get(f.runId).members.map((member) => member.role)).toEqual(['developer', 'architect', 'tester']);
    expect(f.ledger.get(f.runId).selectedSourceId).toBe('architect');
    await f.step();
    await f.answer();
    await f.step();
    expect(f.ledger.get(f.runId)).toMatchObject({ approval: { sourcePaneId: 'architect' }, status: 'ready' });
    expect(await f.workflow.prepareMerge(f.runId)).toEqual({ paneId: 'architect', success: true });
    expect(await f.workflow.validatePaneMerge(f.panes.get('developer')!)).toMatch(/selected registered/);
    expect(await f.native.resolve('architect')).toMatchObject({ success: false });
    expect(f.panes.has('developer')).toBe(true);
  });

  it('rejects comparison/source drift and retains the counterpart for explicit recovery', async () => {
    const f = await fixture({ mode: 'duel' });
    await f.step();
    await f.step();
    await f.answer();
    const decision = f.ledger.get(f.runId).decisions.at(-1);
    writeFileSync(join(f.panes.get('developer')?.worktreePath ?? '', 'code.txt'), 'drifted\n');
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'architect', runId: f.runId })).toMatchObject({ error: expect.stringMatching(/changed/), success: false });
    expect(f.ledger.get(f.runId).selectedSourceId).toBeUndefined();
    f.activities.set('developer', { ...ready, liveness: 'stopped', state: 'stopped' });
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'retry', runId: f.runId })).toEqual({ success: true });
    await f.step();
    expect(f.resumes).toContain('developer');
    expect(readFileSync(join(f.panes.get('developer')?.worktreePath ?? '', 'code.txt'), 'utf8')).toBe('drifted\n');
    expect(f.ledger.get(f.runId).members).toHaveLength(3);
  });

  it('rejects target drift after the comparison without selecting a winner', async () => {
    const f = await fixture({ mode: 'duel' });
    await f.step();
    await f.step();
    await f.answer();
    writeFileSync(join(f.root, 'target.txt'), 'new target\n');
    git(f.root, ['add', 'target.txt']);
    git(f.root, ['commit', '-qm', 'target advanced']);
    const decision = f.ledger.get(f.runId).decisions.at(-1);

    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'architect', runId: f.runId })).toMatchObject({ error: expect.stringMatching(/target changed/), success: false });
    expect(f.ledger.get(f.runId).selectedSourceId).toBeUndefined();
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('architect')).toBe(true);
  });

  it('recovers a partial native Duel launch without replacing the first candidate or changing its base', async () => {
    const f = await fixture({ mode: 'duel' }, 'architect');
    const initial = f.ledger.get(f.runId);
    const firstPath = initial.members[0].worktreePath;
    expect(initial).toMatchObject({ status: 'waiting' });
    expect(initial.members).toHaveLength(1);
    expect(f.panes.get('developer')?.duel?.groupId).toBe(f.runId);
    const decision = initial.decisions.at(-1);
    f.setFailRole();

    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'retry', runId: f.runId })).toEqual({ success: true });
    await f.step();

    expect(f.ledger.get(f.runId).members).toHaveLength(3);
    expect(f.ledger.get(f.runId).members[0].worktreePath).toBe(firstPath);
    expect(readFileSync(join(firstPath, 'code.txt'), 'utf8')).toBe('developer implementation\n');
    expect(f.launches.filter((launch) => launch.pane.id === 'developer')).toHaveLength(1);
    expect(f.launches.every((launch) => launch.options.worktreeStartPoint === initial.baseSha)).toBe(true);
  });

  it('restores native model and effort from the journal when the original writer pane is absent', async () => {
    const f = await fixture({
      duelSides: [{ agent: 'claude', effort: 'high', model: 'opus' }, { agent: 'codex', effort: 'low', model: 'writer-model' }],
      mode: 'duel',
    });
    const restarted = new TeamWorkflow(f.dependencies);
    const run = restarted.list()[0];
    const writer = run.members.find((member) => member.role === 'architect')!;
    f.panes.delete(writer.paneId);
    let restoredTuning: { effort?: string; model?: string } | undefined;
    f.dependencies.resumePane = async (paneId) => {
      const member = restarted.list()[0].members.find((candidate) => candidate.paneId === paneId)!;
      const missingPane = f.panes.get(paneId);
      expect(missingPane).toBeUndefined();
      restoredTuning = { effort: member.effort ?? missingPane?.effort, model: member.model ?? missingPane?.model };
      f.panes.set(paneId, {
        agent: member.agent, ...restoredTuning, id: paneId, paneId: '%recovered',
        projectRoot: run.projectRoot, prompt: run.brief, slug: member.role,
        teamRunId: run.id, worktreePath: member.worktreePath,
      });
      f.activities.set(paneId, { ...ready, paneIncarnationId: 'reconstructed-native-writer' });
      return { success: true };
    };
    const internal = restarted as unknown as { ledger: TeamLedger; step(id: string): Promise<void> };
    internal.ledger.commit(run.id, { step: 'build', type: 'recovery' });
    internal.ledger.commit(run.id, { next: 'recover', type: 'next' });

    await internal.step(run.id);

    expect(restoredTuning).toEqual({ effort: 'low', model: 'writer-model' });
    expect(f.panes.get(writer.paneId)).toMatchObject({ effort: 'low', model: 'writer-model', worktreePath: writer.worktreePath });
    expect(restarted.list()[0].plannedMembers?.find((member) => member.role === 'architect')).toMatchObject({ effort: 'low', model: 'writer-model' });
    expect(restarted.list()[0].members.find((member) => member.role === 'architect')).toMatchObject({ effort: 'low', model: 'writer-model', readOnly: false });
    expect(readFileSync(join(writer.worktreePath, 'code.txt'), 'utf8')).toBe('architect implementation\n');
  });

  it('adopts both native orphan candidates without counting old argv replies as new recovery answers', async () => {
    const f = await fixture({ mode: 'duel' });
    const original = f.ledger.get(f.runId);
    const journal = join(f.root, '.muxbase', 'teams', f.runId, 'events.ndjson');
    const records = readFileSync(journal, 'utf8').trim().split('\n').map((line) => {
      const record: { at: number; events: TeamEvent[]; version: 1 } = JSON.parse(line);
      return { ...record, events: record.events.filter((event) => event.type !== 'member' || event.member.readOnly) };
    }).filter((record) => record.events.length);
    writeFileSync(journal, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const restarted = new TeamWorkflow(f.dependencies);
    restarted.list();
    const internal = restarted as unknown as { ledger: TeamLedger; step(id: string): Promise<void> };
    internal.ledger.commit(f.runId, { step: 'build', type: 'recovery' });
    internal.ledger.commit(f.runId, { next: 'recover', type: 'next' });

    await internal.step(f.runId);
    expect(internal.ledger.get(f.runId).members).toHaveLength(3);
    expect(f.launches).toHaveLength(3);
    const round = openRound(internal.ledger.get(f.runId))!;
    expect(round.deliveryAttempts?.developer).toBeUndefined();
    expect(round.deliveryAttempts?.architect).toBeUndefined();
    await internal.step(f.runId);

    expect(openRound(internal.ledger.get(f.runId))?.failures).toEqual({});
    expect(openRound(internal.ledger.get(f.runId))?.positions).toEqual({});
    expect(openRound(internal.ledger.get(f.runId))?.undelivered).toEqual([]);
    expect(readFileSync(join(original.members[0].worktreePath, 'code.txt'), 'utf8')).toBe('developer implementation\n');
  });

  it('permits exactly two automated fixes after the initial build', async () => {
    const f = await fixture({ checkCommand: 'false', maxFixRounds: 2 });
    const notices: Array<{ message: string; run?: TeamRun }> = [];
    f.dependencies.notify = (message, run) => { notices.push({ message, run }); };
    await f.step();
    await f.step();
    expect(f.ledger.get(f.runId).fixAttempts).toBe(1);
    await f.step();
    await f.answer();
    await f.step();
    expect(f.ledger.get(f.runId).fixAttempts).toBe(2);
    await f.step();
    await f.answer();
    await f.step();
    expect(f.ledger.get(f.runId)).toMatchObject({ fixAttempts: 2, status: 'waiting' });
    expect(f.ledger.get(f.runId).rounds.filter((round) => round.kind === 'build')).toHaveLength(3);
    expect(f.ledger.get(f.runId).decisions.at(-1)?.kind).toBe('fix-limit');
    expect(notices.at(-1)?.run).toMatchObject({ id: f.runId, projectRoot: f.ledger.get(f.runId).projectRoot, status: 'waiting' });
    expect(notices.at(-1)?.message).toContain('Team needs your call:');
  });
});

describe('persistent Team limit pauses', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('quiesces all members and requires a finite extension before resuming preserved work', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 10 } });
    for (const [id, activity] of f.activities) f.activities.set(id, { ...activity, state: 'working' });
    f.setUsage(10);
    f.internal.tick();
    await f.internal.limits.drain();
    expect(f.ledger.get(f.runId)).toMatchObject({ limitPause: { quiesced: true }, status: 'waiting' });
    expect(f.interrupts).toEqual(['developer', 'tester']);
    const decision = f.ledger.get(f.runId).decisions.at(-1);
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'extend', runId: f.runId })).toMatchObject({ success: false });
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', extension: { maxDurationMs: 60_000, maxTokens: 10 }, optionId: 'extend', runId: f.runId })).toMatchObject({ success: false });
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', extension: { maxDurationMs: 120_000, maxTokens: 100 }, optionId: 'extend', runId: f.runId })).toEqual({ success: true });
    expect(f.ledger.get(f.runId)).toMatchObject({ limits: { maxDurationMs: 120_000, maxTokens: 100 }, next: 'recover' });
    await f.step();
    expect(f.resumes).toEqual(['developer', 'tester']);
    expect(f.ledger.get(f.runId).limitPause).toBeUndefined();
    expect(f.ledger.get(f.runId).tokenUsage).toBe(20);
    const reloaded = new TeamWorkflow(f.dependencies).list()[0];
    expect(reloaded.limits).toEqual({ maxDurationMs: 120_000, maxTokens: 100 });
    expect(reloaded.decisions.at(-1)?.chosen).toBe('extend');
    f.setUsage(100);
    f.internal.tick();
    await f.internal.limits.drain();
    expect(f.ledger.get(f.runId)).toMatchObject({ limitPause: { quiesced: true }, status: 'waiting', tokenUsage: 200 });
    expect(f.ledger.get(f.runId).decisions.at(-1)?.chosen).toBeUndefined();
    expect(f.ledger.get(f.runId).limits?.maxTokens).toBe(100);
  });

  it('restores an unresolved human escalation after extending and recovering', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 10 } });
    const decision: TeamDecision = {
      id: 'pending-human', kind: 'member-failed', label: 'D-1', openedAt: Date.now(),
      options: [{ holders: [], id: 'retry', title: 'Retry' }], retryStep: 'build',
      settled: [], title: 'Choose a contract', why: 'Needs a person',
    };
    f.ledger.commit(f.runId, { decision, type: 'decision-opened' });
    f.setUsage(10);
    f.internal.tick();
    await f.internal.limits.drain();
    const cap = f.ledger.get(f.runId).decisions.at(-1);
    expect(await f.workflow.decide({ decisionId: cap?.id ?? '', extension: { maxDurationMs: 120_000, maxTokens: 100 }, optionId: 'extend', runId: f.runId })).toEqual({ success: true });
    await f.step();
    expect(f.ledger.get(f.runId).status).toBe('waiting');
    expect(f.ledger.get(f.runId).decisions.find((item) => item.id === decision.id)?.chosen).toBeUndefined();
    expect(await f.workflow.decide({ decisionId: decision.id, optionId: 'retry', runId: f.runId })).toEqual({ success: true });
  });

  it('restores the original question after retrying a newer recovery failure', async () => {
    const f = await fixture();
    const question: TeamDecision = {
      id: 'original-question', kind: 'member-failed', label: 'D-1', openedAt: Date.now(),
      options: [{ holders: [], id: 'retry', title: 'Provide contract guidance' }], retryStep: 'build',
      settled: [], title: 'Choose a contract', why: 'A human-owned question',
    };
    f.ledger.commit(f.runId, { decision: question, type: 'decision-opened' });
    const retry = { ...question, id: 'newer-recovery-error', label: 'D-2', title: 'Recovery failed', why: 'Resume failed' };
    f.ledger.commit(f.runId, { decision: retry, type: 'decision-opened' });

    expect(await f.workflow.decide({ decisionId: retry.id, optionId: 'retry', runId: f.runId })).toEqual({ success: true });
    await f.step();

    expect(f.ledger.get(f.runId).status).toBe('waiting');
    expect(f.ledger.get(f.runId).next).toBeUndefined();
    expect(f.ledger.get(f.runId).decisions.find((decision) => decision.id === question.id)?.chosen).toBeUndefined();
    expect(await f.workflow.decide({ decisionId: question.id, optionId: 'retry', runId: f.runId })).toEqual({ success: true });
  });

  it('keeps a failed quiescence visible and never resumes with an unverified missing writer', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 10 } });
    f.panes.delete('developer');
    f.setUsage(10);
    f.internal.tick();
    await f.internal.limits.drain();
    expect(f.ledger.get(f.runId)).toMatchObject({ error: expect.stringMatching(/could not confirm quiescence/), limitPause: { quiesced: false }, status: 'waiting' });
    const decision = f.ledger.get(f.runId).decisions.at(-1);

    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', extension: { maxDurationMs: 120_000, maxTokens: 100 }, optionId: 'extend', runId: f.runId })).toMatchObject({ error: expect.stringMatching(/missing/), success: false });
    expect(f.ledger.get(f.runId).limits?.maxTokens).toBe(10);
    expect(f.ledger.get(f.runId).limitPause?.quiesced).toBe(false);
    expect(f.resumes).toEqual([]);
  });

  it('surfaces continuation failure instead of quietly restarting indefinitely after an extension', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 10 } });
    for (const [id, activity] of f.activities) f.activities.set(id, { ...activity, state: 'working' });
    f.setUsage(10);
    f.internal.tick();
    await f.internal.limits.drain();
    const decision = f.ledger.get(f.runId).decisions.at(-1);
    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', extension: { maxDurationMs: 120_000, maxTokens: 100 }, optionId: 'extend', runId: f.runId })).toEqual({ success: true });
    f.dependencies.resumePane = async () => ({ error: 'Explicit resume failed', success: false });

    f.internal.tick();
    await f.internal.execution.drain(f.runId);
    await new Promise((complete) => setImmediate(complete));

    expect(f.ledger.get(f.runId).status).toBe('waiting');
    expect(f.ledger.get(f.runId).decisions.at(-1)).toMatchObject({ kind: 'member-failed', why: 'Explicit resume failed' });
    expect(f.ledger.get(f.runId).limits).toEqual({ maxDurationMs: 120_000, maxTokens: 100 });
    const count = f.ledger.get(f.runId).rounds.length;
    f.internal.tick();
    await new Promise((complete) => setImmediate(complete));
    expect(f.ledger.get(f.runId).rounds).toHaveLength(count);
  });

  it('quiesces and preserves both Duel candidate worktrees when the human stops at a cap', async () => {
    const f = await fixture({ limits: { maxDurationMs: 60_000, maxTokens: 10 }, mode: 'duel' });
    for (const [id, activity] of f.activities) f.activities.set(id, { ...activity, state: 'working' });
    f.setUsage(10);
    f.internal.tick();
    await f.internal.limits.drain();
    const decision = f.ledger.get(f.runId).decisions.at(-1);
    expect(f.interrupts).toEqual(['developer', 'architect', 'tester']);

    expect(await f.workflow.decide({ decisionId: decision?.id ?? '', optionId: 'stop', runId: f.runId })).toEqual({ success: true });

    expect(f.ledger.get(f.runId).status).toBe('stopped');
    expect(f.panes.has('developer')).toBe(true);
    expect(f.panes.has('architect')).toBe(true);
    expect(f.panes.has('tester')).toBe(false);
    expect(readFileSync(join(f.panes.get('developer')?.worktreePath ?? '', 'code.txt'), 'utf8')).toBe('developer implementation\n');
    expect(readFileSync(join(f.panes.get('architect')?.worktreePath ?? '', 'code.txt'), 'utf8')).toBe('architect implementation\n');
  });

  it('recovers a crash between pause persistence and opening the human limit decision', async () => {
    const f = await fixture();
    f.ledger.commit(f.runId, { pause: { at: Date.now(), quiesced: false, reason: 'Elapsed cap', resumeStep: 'build' }, type: 'limit-pause' });
    f.ledger.commit(f.runId, { status: 'waiting', type: 'status' });
    const restarted = new TeamWorkflow(f.dependencies);
    restarted.list();
    const internal = restarted as unknown as { tick(): void; limits: { drain(): Promise<void> } };

    internal.tick();
    await internal.limits.drain();

    expect(restarted.list()[0]).toMatchObject({ limitPause: { quiesced: true }, status: 'waiting' });
    expect(restarted.list()[0].decisions.at(-1)?.kind).toBe('limit');
  });
});

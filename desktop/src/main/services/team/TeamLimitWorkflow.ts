import { randomUUID } from 'node:crypto';
import type { TeamDecideRequest, TeamNextStep, TeamRun, TeamRunLimits } from '../../../shared/team-types.js';
import { TEAM_DEFAULT_DURATION_MS, TEAM_DEFAULT_TOKEN_BUDGET, TEAM_EXTEND_OPTION, TEAM_STOP_OPTION } from '../../../shared/team-types.js';
import { formatError } from '../../utils/formatError.js';
import { log } from '../Logger.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import type { TeamMemberLifecycle } from './TeamMemberLifecycle.js';
import { openRound } from './teamProtocol.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamLimitWorkflow {
  private readonly pausing = new Map<string, Promise<void>>();

  constructor(
    private readonly ledger: TeamLedger,
    private readonly dependencies: TeamWorkflowDependencies,
    private readonly execution: TeamExecution,
    private readonly members: TeamMemberLifecycle,
  ) {}

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pausing.values()]);
  }

  recoverPause(runId: string): void {
    const run = this.ledger.get(runId);
    if (!run.limitPause || this.pausing.has(runId) || run.decisions.some((decision) => decision.kind === 'limit' && !decision.chosen)) return;
    this.execution.abort(runId);
    const job = this.quiesce(runId).catch((error) => {
      this.ledger.commit(runId, { error: `Recovered limit pause could not confirm quiescence: ${formatError(error)}`, status: 'waiting', type: 'status' });
      log.error('team', 'Recovered Team limit pause failed', error);
    }).finally(() => {
      this.openDecision(runId);
      this.pausing.delete(runId);
    });
    this.pausing.set(runId, job);
  }

  pause(runId: string, reason: string): Promise<void> {
    const existing = this.pausing.get(runId);
    if (existing) return existing;
    const run = this.ledger.get(runId);
    if (run.limitPause) return Promise.resolve();
    const pending = run.decisions.filter((decision) => !decision.chosen).at(-1);
    const previous = run.recoveryStep ?? run.next ?? openRound(run)?.kind ?? run.stage;
    const resumeStep: TeamNextStep = previous === 'ship' || previous === 'review' || previous === 'recover' ? 'check' : previous;
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { pause: { at: Date.now(), pendingDecisionId: pending?.id, quiesced: false, reason, resumeStep }, type: 'limit-pause' });
      this.ledger.commit(runId, { status: 'waiting', type: 'status' });
      this.ledger.commit(runId, { type: 'next' });
      this.ledger.lead(runId, `${reason} Quiescing all members before any extension or stop. Worktrees are preserved.`);
    });
    this.execution.abort(runId);
    const job = this.quiesce(runId).catch((error) => {
      this.ledger.commit(runId, { error: `Limit pause could not confirm quiescence: ${formatError(error)}`, status: 'waiting', type: 'status' });
      log.error('team', 'Team limit pause failed', error);
    }).finally(() => {
      this.openDecision(runId);
      this.pausing.delete(runId);
    });
    this.pausing.set(runId, job);
    return job;
  }

  private async quiesce(runId: string): Promise<void> {
    await this.execution.drain(runId);
    await this.dependencies.runProjectMutation(async () => {
      await this.members.quiesce(runId);
      this.execution.observeUsage(runId);
      const pause = this.ledger.get(runId).limitPause;
      if (!pause) throw new Error('The limit pause was lost');
      this.ledger.transaction(runId, () => {
        this.ledger.commit(runId, { pause: { ...pause, quiesced: true }, type: 'limit-pause' });
        this.ledger.commit(runId, { type: 'approved' });
        this.ledger.commit(runId, { type: 'check-snapshot' });
      });
    });
  }

  private openDecision(runId: string): void {
    const run = this.ledger.get(runId);
    if (!run.limitPause || run.status === 'stopping' || run.status === 'stopped') return;
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { decision: {
        id: randomUUID(), kind: 'limit', label: `D-${run.decisions.length + 1}`, openedAt: Date.now(),
        options: [{ holders: [], id: TEAM_EXTEND_OPTION, title: 'Extend limits and resume' }, { holders: [], id: TEAM_STOP_OPTION, title: 'Stop this run' }],
        settled: run.agreements.map((agreement) => agreement.text),
        title: 'The Team reached a run limit',
        why: `${run.limitPause?.reason} Set explicit larger total limits to resume. Already-observed tokens remain spent.`,
      }, type: 'decision-opened' });
      const decision = this.ledger.get(runId).decisions.at(-1);
      if (decision) this.ledger.feed(runId, { decisionId: decision.id, kind: 'decision', lane: 'contested' });
    });
    this.dependencies.notify('Team paused at its limit. Extend its finite limits or stop.');
  }

  private validateExtension(run: TeamRun, extension?: TeamRunLimits): TeamRunLimits {
    if (!extension || !Number.isSafeInteger(extension.maxTokens) || !Number.isSafeInteger(extension.maxDurationMs)) throw new Error('Provide explicit finite total token and time limits');
    const current = run.limits ?? { maxDurationMs: TEAM_DEFAULT_DURATION_MS, maxTokens: TEAM_DEFAULT_TOKEN_BUDGET };
    if (extension.maxTokens < current.maxTokens || extension.maxDurationMs < current.maxDurationMs
      || (extension.maxTokens === current.maxTokens && extension.maxDurationMs === current.maxDurationMs)) throw new Error('An extension must increase a total limit without reducing either existing cap');
    if (extension.maxTokens <= (run.tokenUsage ?? 0) || extension.maxDurationMs <= Date.now() - run.createdAt) throw new Error('Extended limits must exceed the backend-observed tokens and elapsed run time');
    return extension;
  }

  async extend(request: TeamDecideRequest): Promise<void> {
    if (this.pausing.has(request.runId)) throw new Error('The Team is still quiescing; wait before extending');
    const run = this.ledger.get(request.runId);
    this.execution.assertProject(run);
    if (!run.limitPause) throw new Error('This run has no limit pause');
    if (!run.limitPause.quiesced) await this.quiesce(run.id);
    await this.dependencies.runProjectMutation(async () => {
      this.execution.assertProject(run);
      this.execution.observeUsage(run.id);
      const current = this.ledger.get(run.id);
      const pause = current.limitPause;
      const decision = current.decisions.find((candidate) => candidate.id === request.decisionId);
      if (!pause?.quiesced || decision?.chosen || decision?.kind !== 'limit' || current.status !== 'waiting') throw new Error('The limit decision is no longer open');
      const limits = this.validateExtension(current, request.extension);
      this.execution.resume(run.id);
      this.ledger.transaction(run.id, () => {
        this.ledger.commit(run.id, { limits, type: 'limits-extended' });
        this.ledger.commit(run.id, { chosen: TEAM_EXTEND_OPTION, decisionId: request.decisionId, note: request.note, type: 'decision-resolved' });
        this.ledger.commit(run.id, { type: 'limit-pause' });
        this.ledger.feed(run.id, { kind: 'human', text: `Explicit extension: ${limits.maxTokens} observed tokens and ${limits.maxDurationMs} ms total.` });
        const round = openRound(current);
        if (round) this.ledger.commit(run.id, { outcome: 'failed', roundId: round.id, type: 'round-closed' });
        this.ledger.commit(run.id, { decisionId: pause.pendingDecisionId, type: 'resume-decision' });
        this.ledger.commit(run.id, { step: pause.resumeStep, type: 'recovery' });
        this.ledger.commit(run.id, { next: 'recover', type: 'next' });
        this.ledger.commit(run.id, { status: 'running', type: 'status' });
      });
    });
  }
}

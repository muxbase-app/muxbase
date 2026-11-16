import type { MuxBasePane } from 'muxbase/core';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isReadyForMutation, type PaneActivity } from '../../../shared/pane-activity.js';
import type { TeamMember, TeamMemberConfig, TeamNextStep, TeamRound, TeamRun } from '../../../shared/team-types.js';
import { formatError } from '../../utils/formatError.js';
import { writeMuxBaseFile } from '../bridge/ReviewWorkflow.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import { TeamPaneOwnership, teamMemberDraft, teamSlotBase } from './TeamPaneOwnership.js';
import { stepFailedDecision } from './teamDecisions.js';
import { buildRoundFile, buildRoundMessage } from './teamPrompts.js';
import { createTeamRound, isTeamRunClosed, openRound } from './teamProtocol.js';
import { teamRoundPath } from './TeamRoundPoller.js';
import { isTeamWriter, teamBuildParticipants } from './teamModes.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

const STOP_SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 100;

export class TeamMemberLifecycle {
  private readonly ending = new Map<string, Promise<void>>();
  private readonly ownership: TeamPaneOwnership;
  constructor(
    private readonly ledger: TeamLedger,
    private readonly dependencies: TeamWorkflowDependencies,
    private readonly execution: TeamExecution,
  ) {
    this.ownership = new TeamPaneOwnership(ledger, dependencies);
  }

  plan(configs: TeamMemberConfig[], projectRoot: string): TeamMemberConfig[] {
    return configs.map((config) => {
      const inherited = this.dependencies.getEffectiveLaunchTuning?.(config.agent, projectRoot);
      return { ...config, effort: config.effort ?? inherited?.effort, model: config.model ?? inherited?.model };
    });
  }

  async checkpointActiveRuns(): Promise<void> {
    const results = await Promise.allSettled(this.execution.runs().map((run) => this.checkpointRun(run)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new Error(`Team shutdown checkpoint failed: ${errors.map((result) => formatError(result.reason)).join('; ')}`);
  }

  private async checkpointRun(run: TeamRun): Promise<void> {
    if (isTeamRunClosed(run) || run.status === 'ready' || run.mergeIntent) return;
    if (run.status === 'stopping') return this.end(run.id, 'stopped');
    await this.dependencies.runProjectMutation(async () => {
      this.execution.assertProject(run);
      await this.ownership.adopt(run.id);
      const current = this.ledger.get(run.id);
      this.execution.observeUsage(run.id);
      const previous = current.recoveryStep ?? current.next ?? openRound(current)?.kind ?? current.stage;
      const step: TeamNextStep = previous === 'recover' || previous === 'ship' || previous === 'review' ? 'check' : previous;
      this.persistCheckpoint(current, step);
      try {
        await this.interruptForCheckpoint(current);
      } catch (error) {
        this.ledger.transaction(run.id, () => {
          this.ledger.commit(run.id, { decision: { ...stepFailedDecision(this.ledger.get(run.id), `Shutdown interruption failed: ${formatError(error)}. Worktrees are preserved.`), retryStep: step }, type: 'decision-opened' });
          this.ledger.commit(run.id, { error: formatError(error), status: 'waiting', type: 'status' });
        });
        throw error;
      }
    });
  }

  private persistCheckpoint(run: TeamRun, step: TeamNextStep): void {
    this.ledger.transaction(run.id, () => {
      this.ledger.commit(run.id, { step, type: 'recovery' });
      if (run.status === 'waiting') {
        this.ledger.lead(run.id, 'The app shut down. Worktrees and the unresolved human decision are kept.');
        return;
      }
      const round = openRound(run);
      if (round) this.ledger.commit(run.id, { outcome: 'failed', roundId: round.id, type: 'round-closed' });
      this.ledger.commit(run.id, { type: 'approved' });
      this.ledger.commit(run.id, { type: 'check-snapshot' });
      this.ledger.commit(run.id, { next: 'recover', type: 'next' });
      this.ledger.commit(run.id, { status: 'running', type: 'status' });
      this.ledger.lead(run.id, 'The app shut down. Worktrees are kept; a new attempt reconciles members before continuing.');
    });
  }

  private async interruptForCheckpoint(run: TeamRun): Promise<void> {
    for (const member of run.members) {
      if (this.dependencies.getPane(member.paneId)) await this.settleMember(member);
    }
  }

  async quiesce(runId: string): Promise<void> {
    await this.ownership.adopt(runId);
    const run = this.ledger.get(runId);
    this.execution.assertProject(run);
    this.execution.observeUsage(runId);
    for (const member of run.members) await this.settleMember(member);
  }

  async end(runId: string, outcome: 'merged' | 'stopped'): Promise<void> {
    const existing = this.ending.get(runId);
    if (existing) return existing;
    if (isTeamRunClosed(this.ledger.get(runId))) return;
    this.ledger.commit(runId, { status: 'stopping', type: 'status' });
    this.execution.abort(runId);
    const ending = (async () => {
      try {
        await this.execution.drain(runId);
        this.execution.observeUsage(runId);
        await this.dependencies.runProjectMutation(() => this.cleanup(runId, outcome));
        this.ledger.commit(runId, { status: outcome, type: 'status' });
      } catch (error) {
        this.ledger.commit(runId, { error: formatError(error), status: 'stopping', type: 'status' });
        throw error;
      } finally {
        this.ending.delete(runId);
      }
    })();
    this.ending.set(runId, ending);
    return ending;
  }

  async cleanupPublishedMerge(runId: string): Promise<string | null> {
    this.execution.abort(runId);
    try {
      await this.execution.drain(runId);
      await this.dependencies.runProjectMutation(() => this.cleanup(runId, 'merged'));
      return null;
    } catch (error) {
      const message = `Git merged the reviewed source, but member cleanup requires attention: ${formatError(error)}`;
      this.ledger.commit(runId, { error: message, status: 'merged', type: 'status' });
      return message;
    }
  }

  async launch(runId: string, configs: TeamMemberConfig[]): Promise<void> {
    const run = this.ledger.get(runId);
    this.execution.assert(run);
    const kind = run.mode === 'council' ? 'design' : 'build';
    const round = createTeamRound(run, kind, configs.filter((config) => kind === 'design' || isTeamWriter(run.mode, config.role)).map((config) => config.role));
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { round, type: 'round-opened' });
      this.ledger.lead(runId, kind === 'design' ? 'Everyone answers alone first, so nobody anchors on the first reply.' : 'Build starts now. Independent reviewers do not write code or vote as authors.');
      this.ledger.feed(runId, { kind: 'round', roundId: round.id });
    });
    for (const config of configs) {
      this.execution.assert(this.ledger.get(runId));
      await this.execution.mutation(this.ledger.get(runId), () => this.createMember(runId, round, config));
    }
    this.execution.assert(this.ledger.get(runId));
    this.ledger.commit(runId, { status: 'running', type: 'status' });
  }

  private async createMember(runId: string, round: TeamRound, config: TeamMemberConfig): Promise<void> {
    await this.ownership.adopt(runId);
    const run = this.ledger.get(runId);
    if (run.members.some((member) => member.role === config.role)) return this.reconcileMember(runId, round, config);
    const draft = teamMemberDraft(run, config);
    const { label, readOnly } = draft;
    const relativePath = teamRoundPath(run, round.id);
    const participates = round.participants.includes(config.role);
    if (participates) this.ledger.commit(runId, { role: config.role, roundId: round.id, state: 'pending', type: 'delivery-attempt' });
    const options = {
      agentPrompt: participates ? buildRoundMessage(relativePath) : 'You are a read-only reviewer. Do not edit, commit, merge, or start a review yet. Wait for the Team round prompt.',
      effort: draft.effort,
      model: draft.model,
      paneTitle: `${label}: ${run.title}`,
      projectRoot: run.projectRoot,
      readOnly,
      role: readOnly ? 'review' as const : undefined,
      slugBase: teamSlotBase(run, config.role),
      teamRunId: run.id,
      useWorktree: true as const,
      worktreeSeedFile: { content: buildRoundFile(run, round, draft), relativePath },
      worktreeStartPoint: run.baseSha,
    };
    const result = await this.launchMember(run, config, options);
    if (!result.pane?.worktreePath) throw new Error(result.error || `Could not start the ${label}`);
    const recovered = 'recovered' in result && result.recovered === true;
    if (recovered) {
      await this.ownership.adopt(runId);
      if (!this.ledger.get(runId).members.some((member) => member.role === config.role)) throw new Error('The recovered Team survivor could not be verified and journaled');
      if (participates) this.ledger.commit(runId, { role: config.role, roundId: round.id, type: 'delivery-reconciled' });
      await this.reconcileMember(runId, round, config);
      return;
    }
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { member: {
        ...draft, effort: draft.effort ?? result.pane?.effort, model: draft.model ?? result.pane?.model,
        paneId: result.pane?.id ?? '', worktreePath: result.pane?.worktreePath ?? '',
      }, type: 'member' });
      if (participates && result.success) {
        this.ledger.commit(runId, { baseline: 0, role: config.role, roundId: round.id, type: 'delivered' });
        this.ledger.commit(runId, { role: config.role, roundId: round.id, state: 'sent', type: 'delivery-attempt' });
      }
    });
    if (!result.success) throw new Error(result.error || `Could not start the ${label}; its preserved pane is recorded`);
    this.execution.assert(this.ledger.get(runId));
  }

  private async launchMember(run: TeamRun, config: TeamMemberConfig, options: Parameters<TeamWorkflowDependencies['createPane']>[2]) {
    try {
      const result = run.mode === 'duel' && !options.readOnly
        ? await this.createDuelCandidate(run, config, options)
        : await this.dependencies.createPane(`${teamMemberDraft(run, config).label}: ${run.title}`, config.agent, options);
      if (!result.pane) await this.ownership.adopt(run.id);
      return result;
    } catch (error) {
      await this.ownership.adopt(run.id);
      throw error;
    }
  }

  private async createDuelCandidate(run: TeamRun, config: TeamMemberConfig, options: Parameters<TeamWorkflowDependencies['createPane']>[2]) {
    if (!this.dependencies.createDuelCandidate || !run.duelSides) throw new Error('The native Team Duel launch integration is unavailable');
    const index = config.role === 'developer' ? 0 : 1;
    const sibling = run.members.find((member) => !member.readOnly && member.role !== config.role);
    return this.dependencies.createDuelCandidate(`${config.role === 'developer' ? 'Candidate A' : 'Candidate B'}: ${run.title}`, {
      ...run.duelSides[index], effort: config.effort ?? run.duelSides[index].effort, model: config.model ?? run.duelSides[index].model,
    }, {
      ...options,
      duel: { groupId: run.id, prompt: run.brief, role: index === 0 ? 'a' : 'b', siblingPaneId: sibling?.paneId },
    });
  }

  async recover(runId: string): Promise<void> {
    await this.ownership.adopt(runId);
    const run = this.ledger.get(runId);
    const { configs, round } = this.recoveryPlan(run);
    this.ledger.transaction(runId, () => {
      const previous = openRound(run);
      if (previous) this.ledger.commit(runId, { outcome: 'failed', roundId: previous.id, type: 'round-closed' });
      this.ledger.commit(runId, { round, type: 'round-opened' });
    });
    for (const config of configs) await this.reconcileMember(runId, round, config);
    this.execution.assert(this.ledger.get(runId));
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { type: 'recovery' });
      if (round.kind === 'review') {
        this.ledger.commit(runId, { outcome: 'failed', roundId: round.id, type: 'round-closed' });
        this.ledger.commit(runId, { next: 'check', type: 'next' });
      }
      if (run.resumeDecisionId || this.ledger.get(runId).decisions.some((decision) => !decision.chosen)) {
        if (round.kind !== 'review') this.ledger.commit(runId, { outcome: 'failed', roundId: round.id, type: 'round-closed' });
        this.ledger.commit(runId, { type: 'next' });
        this.ledger.commit(runId, { type: 'resume-decision' });
        this.ledger.commit(runId, { status: 'waiting', type: 'status' });
      }
      this.ledger.feed(runId, { kind: 'round', roundId: round.id });
    });
  }

  private recoveryPlan(run: TeamRun): { configs: TeamMemberConfig[]; round: TeamRound } {
    const step = run.recoveryStep ?? (run.mode === 'council' ? 'design' : 'build');
    const kind = step === 'build' ? 'build' : step === 'design' ? 'design' : 'review';
    const configs = run.plannedMembers ?? run.members;
    const participants = kind === 'build'
      ? (run.members.length === configs.length ? teamBuildParticipants(run) : configs.filter((member) => isTeamWriter(run.mode, member.role)).map((member) => member.role))
      : configs.filter((member) => kind === 'design' || !isTeamWriter(run.mode, member.role)).map((member) => member.role);
    return { configs, round: createTeamRound(run, kind, participants) };
  }

  private async reconcileMember(runId: string, round: TeamRound, config: TeamMemberConfig): Promise<void> {
    const run = this.ledger.get(runId);
    this.execution.assert(run);
    const member = run.members.find((candidate) => candidate.role === config.role);
    if (!member) return this.createMember(runId, round, config);
    const activity = this.dependencies.getPaneActivity(member.paneId);
    const dead = activity?.liveness === 'stopped' && activity.certainty === 'confirmed';
    if (!this.dependencies.getPane(member.paneId) || dead) await this.resumeMember(runId, member);
    this.execution.assert(this.ledger.get(runId));
    writeMuxBaseFile(join(member.worktreePath, teamRoundPath(run, round.id)), buildRoundFile(run, round, member));
  }

  private async resumeMember(runId: string, member: TeamMember): Promise<void> {
    const before = this.dependencies.getPaneActivity(member.paneId);
    const resumed = await this.dependencies.resumePane(member.paneId);
    if (!resumed.success) throw new Error(resumed.error || `Could not resume the ${member.label} in its kept worktree`);
    this.execution.assert(this.ledger.get(runId));
    const pane = this.dependencies.getPane(member.paneId);
    if (!pane || pane.worktreePath !== member.worktreePath || pane.projectRoot !== this.ledger.get(runId).projectRoot) {
      throw new Error(`The ${member.label} recovery did not restore its registered pane and preserved worktree`);
    }
    const after = this.dependencies.getPaneActivity(member.paneId);
    if (!after || (before && after.paneIncarnationId === before.paneIncarnationId)) throw new Error(`The ${member.label} recovery did not establish a new pane incarnation`);
    this.ledger.commit(runId, { member: { ...member, paneId: pane.id, worktreePath: pane.worktreePath }, type: 'member' });
  }

  async cleanup(runId: string, outcome: 'merged' | 'stopped'): Promise<void> {
    await this.ownership.adopt(runId);
    const run = this.ledger.get(runId);
    this.execution.assertProject(run);
    this.execution.observeUsage(runId);
    if (outcome === 'stopped') {
      for (const writer of run.members.filter((member) => !member.readOnly)) await this.settleMember(writer);
    }
    const errors: string[] = [];
    for (const member of run.members.filter((candidate) => candidate.readOnly)) {
      this.execution.assertProject(run);
      const pane = this.dependencies.getPane(member.paneId);
      if (!pane) continue;
      this.assertCleanupOwnership(run, member, pane);
      await this.settleMember(member);
      const current = this.dependencies.getPane(member.paneId);
      if (!current) continue;
      this.assertCleanupOwnership(run, member, current);
      const error = await this.dependencies.closePane(current);
      if (error) errors.push(`${member.label}: ${error}`);
    }
    if (errors.length) throw new Error(`Team cleanup failed: ${errors.join('; ')}`);
  }

  private assertCleanupOwnership(run: TeamRun, member: TeamMember, pane: MuxBasePane): void {
    if (pane.agent !== member.agent || pane.role !== 'review'
      || !pane.projectRoot || realpathSync(pane.projectRoot) !== realpathSync(run.projectRoot)
      || !pane.worktreePath || realpathSync(pane.worktreePath) !== realpathSync(member.worktreePath)
      || (pane.teamRunId && pane.teamRunId !== run.id)) {
      throw new Error(`The ${member.label} cleanup ownership changed; its pane and worktree are preserved`);
    }
  }

  private async settleMember(member: TeamMember): Promise<void> {
    if (!this.dependencies.getPane(member.paneId)) throw new Error(`The kept ${member.label} pane is missing; its stopped liveness cannot be confirmed`);
    const before = this.dependencies.getPaneActivity(member.paneId);
    if (this.memberIsSettled(member)) return;
    await this.dependencies.interruptPane(member.paneId);
    const deadline = Date.now() + STOP_SETTLE_MS;
    while (Date.now() < deadline) {
      if (this.memberIsSettled(member, before)) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }

    throw new Error(`The ${member.label} did not confirm ready or stopped liveness with no running background work after interruption; its worktree is preserved`);
  }

  private memberIsSettled(member: TeamMember, before?: PaneActivity): boolean {
    const activity = this.dependencies.getPaneActivity(member.paneId);
    if (!activity || activity.openBackgroundWork.length !== 0) return false;
    if (activity.certainty === 'confirmed' && activity.liveness === 'stopped') return true;
    const session = this.dependencies.getSession(member.paneId);
    const acknowledged = !before || activity.paneIncarnationId !== before.paneIncarnationId || activity.activityRevision > before.activityRevision;
    return acknowledged && isReadyForMutation(activity) && !session?.isOngoing && !session?.awaitingUserInput;
  }
}

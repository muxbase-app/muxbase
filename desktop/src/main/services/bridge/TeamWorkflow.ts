import { assertTeamPublicationSupport, type MuxBasePane } from 'muxbase/core';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TEAM_SETTINGS } from '../../../shared/team-settings.js';
import {
  TEAM_ACCEPT_OPTION,
  TEAM_EXTEND_OPTION,
  TEAM_MAX_ACTIVE_RUNS,
  TEAM_STOP_OPTION,
  type TeamActionResponse,
  type TeamDecideRequest,
  type TeamDecision,
  type TeamFinishRequest,
  type TeamNoteRequest,
  type TeamPrepareMergeResponse,
  type TeamRun,
  type TeamStartRequest,
  type TeamStartResponse,
} from '../../../shared/team-types.js';
import { formatError } from '../../utils/formatError.js';
import { log } from '../Logger.js';
import { gitOrThrow } from '../git/gitDiff.js';
import { TeamApprovalWorkflow } from '../team/TeamApprovalWorkflow.js';
import { TeamDecisionWorkflow } from '../team/TeamDecisionWorkflow.js';
import { TeamDuelWorkflow } from '../team/TeamDuelWorkflow.js';
import { TeamExecution } from '../team/TeamExecution.js';
import { TeamLedger } from '../team/TeamLedger.js';
import { TeamLimitWorkflow } from '../team/TeamLimitWorkflow.js';
import { TeamMemberLifecycle } from '../team/TeamMemberLifecycle.js';
import { TeamMergeWorkflow } from '../team/TeamMergeWorkflow.js';
import { TeamRoundPoller } from '../team/TeamRoundPoller.js';
import { TeamRoundProgression } from '../team/TeamRoundProgression.js';
import { detectCheckCommand } from '../team/teamChecks.js';
import { decisionText, isKnownOption, stepFailedDecision } from '../team/teamDecisions.js';
import { resolveTeamRequest } from '../team/teamModes.js';
import { isTeamRunClosed, teamDeveloper } from '../team/teamProtocol.js';
import { excludeMetadataFromGit, runTitle, validateRoster } from '../team/teamRoster.js';
import type { TeamWorkflowDependencies } from '../team/teamWorkflowTypes.js';

const TICK_MS = 2000;

export class TeamWorkflow {
  private readonly busy = new Set<string>();
  private readonly ledger: TeamLedger;
  private readonly progression: TeamRoundProgression;
  private readonly execution: TeamExecution;
  private readonly approvals: TeamApprovalWorkflow;
  private readonly members: TeamMemberLifecycle;
  private readonly merges: TeamMergeWorkflow;
  private readonly decisions: TeamDecisionWorkflow;
  private readonly duel: TeamDuelWorkflow;
  private readonly limits: TeamLimitWorkflow;
  private pendingStarts = 0;
  private shuttingDown = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dependencies: TeamWorkflowDependencies) {
    this.ledger = new TeamLedger(dependencies.getProjectRoot, dependencies.emitRun);
    this.execution = new TeamExecution(this.ledger, dependencies);
    this.approvals = new TeamApprovalWorkflow(this.ledger, dependencies, this.execution);
    this.members = new TeamMemberLifecycle(this.ledger, dependencies, this.execution);
    this.merges = new TeamMergeWorkflow(this.ledger, dependencies, this.execution, this.approvals, this.members);
    this.decisions = new TeamDecisionWorkflow(this.ledger, (id, decision) => this.openDecision(id, decision), (id, title, text, votes) => this.recordAgreement(id, title, text, votes));
    this.duel = new TeamDuelWorkflow(this.ledger, dependencies, this.execution, this.approvals);
    this.limits = new TeamLimitWorkflow(this.ledger, dependencies, this.execution, this.members);
    this.progression = new TeamRoundProgression({
      approvals: this.approvals,
      decisions: this.decisions,
      dependencies,
      duel: this.duel,
      execution: this.execution,
      ledger: this.ledger,
      members: this.members,
      openDecision: (id, decision) => this.openDecision(id, decision),
      poller: new TeamRoundPoller(this.ledger, dependencies),
      recordAgreement: (id, title, text, votes) => this.recordAgreement(id, title, text, votes),
    });
  }

  start(): void {
    void this.recoverPaneMerges().catch((error) => {
      log.error('team', 'Team merge receipt recovery failed', error);
      this.dependencies.notify(`Team merge receipt recovery failed: ${formatError(error)}`);
    });
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.shuttingDown = true;
    this.execution.shutdown();
    await Promise.allSettled(this.execution.runs().map((run) => this.execution.drain(run.id)));
    await this.limits.drain();
    while (this.pendingStarts) await new Promise((resolve) => setTimeout(resolve, 50));
    await this.members.checkpointActiveRuns();
  }

  list(): TeamRun[] {
    this.execution.runs();
    return this.ledger.list();
  }

  assertProjectSwitchAllowed(): void {
    const active = this.execution.runs().some((run) => run.projectRoot === this.dependencies.getProjectRoot() && (['starting', 'running', 'waiting', 'stopping'].includes(run.status) || run.mergeIntent?.state === 'prepared'));
    if (active || this.pendingStarts || this.execution.hasWork()) throw new Error('Stop the active team run and wait for its operations before switching projects');
  }

  async startRun(request: TeamStartRequest): Promise<TeamStartResponse> {
    let resolved: ReturnType<typeof resolveTeamRequest>;
    try {
      resolved = resolveTeamRequest(request, this.dependencies.getDefaults?.() ?? DEFAULT_TEAM_SETTINGS, this.dependencies.getAvailableAgents?.());
    } catch (error) {
      return { error: formatError(error), success: false };
    }
    const invalid = validateRoster(resolved);
    if (invalid) return { error: invalid, success: false };
    if (!this.dependencies.hasActiveProjectContext()) return { error: 'Open a project first', success: false };
    if (this.shuttingDown) return { error: 'The app is shutting down', success: false };
    const count = this.execution.runs().filter((run) => !isTeamRunClosed(run)).length;
    if (count + this.pendingStarts >= TEAM_MAX_ACTIVE_RUNS) return { error: `At most ${TEAM_MAX_ACTIVE_RUNS} team runs may be active`, success: false };
    this.pendingStarts++;
    const projectRoot = this.dependencies.getProjectRoot();
    try {
      const [baseSha, commonDir] = await this.dependencies.runProjectMutation(async () => {
        if (this.shuttingDown || this.dependencies.getProjectRoot() !== projectRoot) throw new Error('The project changed or the app is shutting down');
        await assertTeamPublicationSupport(projectRoot);
        const values = await Promise.all([
          gitOrThrow(projectRoot, ['rev-parse', 'HEAD']),
          gitOrThrow(projectRoot, ['rev-parse', '--git-common-dir']),
        ]);
        if (this.shuttingDown || this.dependencies.getProjectRoot() !== projectRoot) throw new Error('The project changed or the app is shutting down');
        return values;
      });
      if (this.shuttingDown || this.dependencies.getProjectRoot() !== projectRoot) throw new Error('The project changed or the app is shutting down');
      excludeMetadataFromGit(projectRoot, commonDir.trim());
      const brief = request.brief.trim();
      const runId = randomUUID();
      const plannedMembers = this.members.plan(resolved.members, projectRoot);
      const run = this.ledger.commit(runId, {
        seed: {
          baseSha: baseSha.trim(),
          brief,
          checkCommand: request.checkCommand?.trim() || detectCheckCommand(projectRoot),
          createdAt: Date.now(),
          id: runId,
          duelSides: resolved.duelSides,
          limits: resolved.limits,
          maxFixRounds: resolved.maxFixRounds,
          mode: resolved.mode,
          plannedMembers,
          policy: resolved.policy,
          projectRoot,
          title: runTitle(brief),
        },
        type: 'created',
      });
      void this.execution.track(run.id, () => this.members.launch(run.id, plannedMembers)).catch((error) => this.failLaunch(run.id, error));
      return { run, success: true };
    } catch (error) {
      log.error('team', 'Team run failed to start', error);
      return { error: formatError(error), success: false };
    } finally {
      this.pendingStarts--;
    }
  }

  async decide(request: TeamDecideRequest): Promise<TeamActionResponse> {
    const run = this.ledger.find(request.runId);
    const decision = run?.decisions.find((candidate) => candidate.id === request.decisionId);
    if (!run || !decision) return { error: 'Decision not found', success: false };
    if (decision.chosen || run.status !== 'waiting' || decision.id !== run.decisions.filter((candidate) => !candidate.chosen).at(-1)?.id) return { error: 'This decision is closed', success: false };
    if (!isKnownOption(decision, request.optionId)) return { error: 'Unknown option', success: false };
    const note = request.note?.trim() || undefined;
    try {
      if (request.optionId === TEAM_STOP_OPTION) {
        this.execution.assertProject(run);
        await this.members.end(run.id, 'stopped');
        return { success: true };
      }
      if (decision.kind === 'limit' && request.optionId === TEAM_EXTEND_OPTION) {
        await this.limits.extend(request);
        return { success: true };
      }
      this.execution.assert(run);
      if (request.optionId === TEAM_ACCEPT_OPTION && !note) return { error: 'Accept as is requires a nonempty waiver reason', success: false };
      await this.execution.track(run.id, () => this.execution.mutation(run, async () => {
        const approval = request.optionId === TEAM_ACCEPT_OPTION ? await this.approvals.waiver(run.id, decision.id, note ?? '') : undefined;
        this.execution.assert(this.ledger.get(run.id));
        const current = this.ledger.get(run.id).decisions.find((candidate) => candidate.id === decision.id);
        if (current?.chosen || this.ledger.get(run.id).status !== 'waiting' || this.ledger.get(run.id).decisions.filter((candidate) => !candidate.chosen).at(-1)?.id !== decision.id) throw new Error('This decision is closed');
        const selection = decision.kind === 'duel-winner' && request.optionId !== 'retry' ? await this.duel.select(run.id, decision, request.optionId) : undefined;
        log.info('team', 'Decision made', { decisionId: decision.id, optionId: request.optionId, runId: run.id });
        this.ledger.transaction(run.id, () => {
          this.ledger.commit(run.id, { chosen: request.optionId, decisionId: decision.id, note, type: 'decision-resolved' });
          if (note) this.ledger.commit(run.id, { text: note, type: 'note' });
          if (approval) this.ledger.commit(run.id, { approval, sha: approval.snapshotSha, type: 'approved' });
          if (selection) {
            this.ledger.commit(run.id, { paneId: selection.paneId, type: 'source-selected' });
            if (selection.checkedSnapshot) this.ledger.commit(run.id, { sha: selection.checkedSnapshot, type: 'check-snapshot' });
            this.ledger.commit(run.id, { next: selection.checksPassed ? 'review' : 'check', type: 'next' });
          }
          this.ledger.feed(run.id, { kind: 'human', lane: 'agreed', text: decisionText(decision, request.optionId, note) });
          this.decisions.apply(run.id, decision, request.optionId);
        });
      }));
      return { success: true };
    } catch (error) {
      return { error: formatError(error), success: false };
    }
  }

  note(request: TeamNoteRequest): TeamActionResponse {
    const run = this.ledger.find(request.runId);
    if (!run) return { error: 'Run not found', success: false };
    try {
      this.execution.assert(run);
    } catch (error) {
      return { error: formatError(error), success: false };
    }
    this.ledger.commit(run.id, { text: request.text.trim(), type: 'note' });
    this.ledger.feed(run.id, { kind: 'human', text: request.text.trim() });
    this.ledger.feed(run.id, { kind: 'lead', text: 'Your note reaches the team at the next round. No agent was interrupted.' });
    return { success: true };
  }

  async prepareMerge(runId: string): Promise<TeamPrepareMergeResponse> {
    await this.merges.waitForRecovery();
    const run = this.ledger.find(runId);
    if (!run || run.status !== 'ready') return { error: 'This run is not ready to merge', success: false };
    const developer = teamDeveloper(run);
    const pane = this.dependencies.getProjectRoot() === run.projectRoot ? this.dependencies.getPane(developer.paneId) : undefined;
    if (!pane) return { error: 'The registered Developer pane is not available in this project', success: false };
    try {
      const error = await this.execution.track(run.id, () => this.execution.mutation(run, () => this.approvals.validate(pane)));
      return error ? { error, success: false } : { paneId: developer.paneId, success: true };
    } catch (error) {
      return { error: formatError(error), success: false };
    }
  }

  async validatePaneMerge(pane: MuxBasePane, worktreePath?: string, sourceRevision?: string): Promise<string | null> {
    await this.merges.waitForRecovery();
    const run = pane.teamRunId ? this.ledger.find(pane.teamRunId) : this.execution.runs().find((candidate) => candidate.members.some((member) => member.paneId === pane.id));
    return run ? this.execution.track(run.id, () => this.approvals.validate(pane, worktreePath, sourceRevision)) : this.approvals.validate(pane, worktreePath, sourceRevision);
  }

  isOwnedWriter(pane: MuxBasePane): boolean {
    const runs = this.ledger.list();
    const active = runs.filter((run) => !isTeamRunClosed(run));
    const known = active.find((run) => run.members.some((member) => member.paneId === pane.id));
    if (known) return known.members.some((member) => member.paneId === pane.id && !member.readOnly);
    if (!pane.teamRunId || pane.role === 'review') return false;
    const tagged = this.ledger.find(pane.teamRunId);
    return !tagged || !isTeamRunClosed(tagged);
  }

  async finish(request: TeamFinishRequest): Promise<TeamActionResponse> {
    await this.merges.waitForRecovery();
    const run = this.ledger.find(request.runId);
    if (!run) return { error: 'Run not found', success: false };
    try {
      this.execution.assertProject(run);
      if (this.merges.isPublishing(run.id)) return { error: 'Wait for the active Git publication to finish before changing this run.', success: false };
      if (request.outcome === 'merged' && run.status === 'merged') return { success: true };
      if (run.mergeIntent) {
        if (request.outcome !== 'merged') return { error: 'Recover the pending Git publication before stopping this run.', success: false };
        const pane = this.dependencies.getPane(run.mergeIntent.sourcePaneId);
        if (!pane) return { error: 'The publication source pane is missing; recover the merge receipt first.', success: false };
        const error = await this.merges.completePane(pane);
        return error ? { error, success: false } : { success: true };
      }
      if (request.outcome === 'merged') {
        return { error: 'A durable Team merge intent and Git publication receipt are required.', success: false };
      }
      await this.members.end(run.id, request.outcome);
      return { success: true };
    } catch (error) {
      return { error: formatError(error), success: false };
    }
  }

  async completePaneMerge(pane: MuxBasePane): Promise<string | null> {
    return this.merges.completePane(pane);
  }

  beginMergeHook(pane: MuxBasePane): string {
    return this.merges.beginHook(pane);
  }

  completeMergeHook(pane: MuxBasePane, error?: string): void {
    this.merges.completeHook(pane, error);
  }

  beginPaneMerge(pane: MuxBasePane, targetPath: string, sourceRevision: string) {
    return this.merges.begin(pane, targetPath, sourceRevision);
  }

  recoverPaneMerges(): Promise<void> {
    return this.merges.recover();
  }

  private tick(): void {
    if (this.shuttingDown) return;
    for (const run of this.execution.runs()) {
      if (isTeamRunClosed(run) || run.status === 'stopping' || run.mergeIntent) continue;
      if (run.limitPause) {
        if (run.projectRoot === this.dependencies.getProjectRoot()) this.limits.recoverPause(run.id);
        continue;
      }
      const limit = this.execution.limitReason(run);
      if (limit) {
        void this.limits.pause(run.id, limit).catch((error) => log.error('team', 'Budget pause failed', error));
        continue;
      }
      if (run.projectRoot !== this.dependencies.getProjectRoot()) continue;
      if (run.status === 'starting' && !this.execution.hasWork(run.id)) {
        this.failLaunch(run.id, new Error('The app closed during launch; inspect the partial roster and deliberately retry.'));
        continue;
      }
      if (run.status !== 'running' || this.busy.has(run.id) || this.execution.hasWork(run.id)) continue;
      this.busy.add(run.id);
      void this.execution.track(run.id, () => this.execution.mutation(run, () => this.step(run.id)))
        .catch((error) => this.failRun(run.id, error))
        .finally(() => this.busy.delete(run.id));
    }
  }

  private failLaunch(runId: string, error: unknown): void {
    if (this.ledger.get(runId).status !== 'starting') return;
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { status: 'running', type: 'status' });
      const step = this.ledger.get(runId).mode === 'council' ? 'design' : 'build';
      this.ledger.commit(runId, { step, type: 'recovery' });
      this.openDecision(runId, { ...stepFailedDecision(this.ledger.get(runId), `Partial launch: ${formatError(error)}. Kept panes and worktrees are recorded; retry reconciles only missing or dead members.`), retryStep: step });
    });
  }

  private failRun(runId: string, error: unknown): void {
    log.error('team', 'Team run step failed', { error, runId });
    const run = this.ledger.find(runId);
    if (run?.status !== 'running') return;
    const retryStep = run.next;
    this.openDecision(runId, { ...stepFailedDecision(run, formatError(error)), retryStep });
  }

  private step(runId: string): Promise<void> {
    return this.progression.step(runId);
  }

  private openDecision(runId: string, decision: TeamDecision): void {
    if (isTeamRunClosed(this.ledger.get(runId)) || this.ledger.get(runId).status === 'stopping') return;
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { decision, type: 'decision-opened' });
      this.ledger.feed(runId, { decisionId: decision.id, kind: 'decision', lane: 'contested' });
    });
    this.dependencies.notify(`Team needs your call: ${decision.title}`, this.ledger.get(runId));
  }

  private recordAgreement(runId: string, title: string, text: string, votes: string): void {
    this.ledger.commit(runId, { agreement: { at: Date.now(), source: votes, text: text ? `${title}: ${text}` : title }, type: 'agreement' });
    this.ledger.feed(runId, { kind: 'agreed', lane: 'agreed', text, title, votes });
  }
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TeamDecision, TeamDuelSnapshot, TeamRound, TeamRun } from '../../../shared/team-types.js';
import { writeMuxBaseFile } from '../bridge/ReviewWorkflow.js';
import { gitOrThrow } from '../git/gitDiff.js';
import type { TeamApprovalWorkflow } from './TeamApprovalWorkflow.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import { teamRoundPath } from './TeamRoundPoller.js';
import { buildRoundFile } from './teamPrompts.js';
import { captureTeamReadiness, revalidateTeamReadiness } from './teamReadiness.js';
import { createTeamRound } from './teamProtocol.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export class TeamDuelWorkflow {
  constructor(
    private readonly ledger: TeamLedger,
    private readonly dependencies: TeamWorkflowDependencies,
    private readonly execution: TeamExecution,
    private readonly approvals: TeamApprovalWorkflow,
  ) {}

  async compare(runId: string): Promise<void> {
    if (!this.approvals.reviewersReady(runId)) return;
    const run = this.ledger.get(runId);
    const writers = run.members.filter((member) => !member.readOnly);
    const reviewers = run.members.filter((member) => member.readOnly);
    if (writers.length !== 2 || !reviewers.length) throw new Error('Duel requires two preserved candidates and a separate read-only comparator');
    const targetSha = (await gitOrThrow(run.projectRoot, ['rev-parse', 'HEAD'])).trim();
    const snapshots: Partial<Record<TeamRun['members'][number]['role'], TeamDuelSnapshot>> = {};
    for (const writer of writers) snapshots[writer.role] = await this.approvals.checkCandidate(runId, writer);
    for (const writer of writers) {
      const snapshot = snapshots[writer.role];
      if (!snapshot) throw new Error('A Duel candidate snapshot is missing');
      await this.approvals.verifyCandidate(runId, writer, snapshot);
    }
    const first = snapshots.developer;
    if (!first) throw new Error('Candidate A has no immutable snapshot');
    for (const reviewer of reviewers) {
      const token = captureTeamReadiness(this.dependencies, reviewer);
      await gitOrThrow(reviewer.worktreePath, ['checkout', '--detach', first.snapshotSha]);
      this.execution.assert(this.ledger.get(runId));
      revalidateTeamReadiness(this.dependencies, reviewer, token);
    }
    for (const writer of writers) {
      const snapshot = snapshots[writer.role];
      if (!snapshot) throw new Error('A Duel candidate snapshot is missing');
      await this.approvals.verifyCandidate(runId, writer, snapshot);
    }
    if ((await gitOrThrow(run.projectRoot, ['rev-parse', 'HEAD'])).trim() !== targetSha) throw new Error('The target changed while the Duel comparison was preparing');
    const round: TeamRound = {
      ...createTeamRound(this.ledger.get(runId), 'review', reviewers.map((member) => member.role)),
      candidateSnapshots: snapshots,
      comparison: true,
      targetSha,
    };
    this.execution.assert(this.ledger.get(runId));
    this.ledger.transaction(runId, () => {
      this.ledger.commit(runId, { pending: false, type: 'check-execution' });
      this.ledger.commit(runId, { snapshots, type: 'duel-snapshots' });
      this.ledger.commit(runId, { stage: 'review', type: 'stage' });
      this.ledger.commit(runId, { round, type: 'round-opened' });
      this.ledger.feed(runId, { kind: 'round', roundId: round.id });
      this.ledger.lead(runId, 'Both candidates are frozen and checked. The read-only comparison is advisory; only you choose the winner, and both worktrees stay.');
    });
    for (const reviewer of reviewers) writeMuxBaseFile(join(reviewer.worktreePath, teamRoundPath(run, round.id)), buildRoundFile(this.ledger.get(runId), round, reviewer));
  }

  winnerDecision(run: TeamRun, round: TeamRound): TeamDecision {
    return {
      id: randomUUID(),
      kind: 'duel-winner',
      label: `D-${run.decisions.length + 1}`,
      openedAt: Date.now(),
      options: [...run.members.filter((member) => !member.readOnly).map((member) => ({
        holders: [member.role],
        id: member.paneId,
        summary: `${round.candidateSnapshots?.[member.role]?.checksPassed ? 'Checks passed' : 'Checks failed'}. ${round.positions.tester?.summary ?? ''}`,
        title: `Select ${member.label}`,
      })), { holders: [], id: 'retry', title: 'Reconcile both candidates and compare again' }],
      roundId: round.id,
      settled: run.agreements.map((agreement) => agreement.text),
      title: 'Which Duel candidate should continue?',
      why: 'The comparison is advisory. Your selected source must pass its binding review before you merge. Both candidates remain preserved.',
    };
  }

  async select(runId: string, decision: TeamDecision, paneId: string): Promise<TeamDuelSnapshot> {
    const run = this.ledger.get(runId);
    const round = run.rounds.find((candidate) => candidate.id === decision.roundId && candidate.comparison);
    if (!round || !round.closedAt) throw new Error('The immutable Duel comparison is not complete');
    for (const member of run.members.filter((candidate) => !candidate.readOnly)) {
      const snapshot = round.candidateSnapshots?.[member.role];
      if (!snapshot) throw new Error('The comparison lost a candidate snapshot; both candidates must be compared again');
      await this.approvals.verifyCandidate(runId, member, snapshot);
    }
    if ((await gitOrThrow(run.projectRoot, ['rev-parse', 'HEAD'])).trim() !== round.targetSha) throw new Error('The target changed after the Duel comparison; compare the candidates again');
    const selected = run.members.find((member) => member.paneId === paneId && !member.readOnly);
    if (!selected) throw new Error('Only a registered Duel candidate can be selected');
    const snapshot = round.candidateSnapshots?.[selected.role];
    if (!snapshot) throw new Error('The selected candidate has no snapshot');
    this.execution.assert(this.ledger.get(runId));
    return snapshot;
  }
}

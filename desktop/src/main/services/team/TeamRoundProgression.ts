import { join } from 'path';
import type {
  TeamDecision,
  TeamNextStep,
  TeamRoleId,
  TeamRound,
  TeamRoundKind,
  TeamRun,
} from '../../../shared/team-types.js';
import { writeMuxBaseFile } from '../bridge/ReviewWorkflow.js';
import type { TeamApprovalWorkflow } from './TeamApprovalWorkflow.js';
import type { TeamDecisionWorkflow } from './TeamDecisionWorkflow.js';
import type { TeamDuelWorkflow } from './TeamDuelWorkflow.js';
import type { TeamExecution } from './TeamExecution.js';
import type { TeamLedger } from './TeamLedger.js';
import type { TeamMemberLifecycle } from './TeamMemberLifecycle.js';
import { type TeamRoundPoller, teamRoundPath } from './TeamRoundPoller.js';
import { approvalDecision, designDecision, humanDecision, memberFailedDecision } from './teamDecisions.js';
import { roundFeed } from './teamFeed.js';
import { teamBuildParticipants } from './teamModes.js';
import { buildRoundFile } from './teamPrompts.js';
import {
  commonProposal,
  createTeamRound,
  designRounds,
  evaluateBuildRound,
  evaluateDesignRound,
  evaluateReviewRound,
  isTeamRunClosed,
  latestProposal,
  openRound,
} from './teamProtocol.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export interface TeamRoundProgressionParts {
  approvals: TeamApprovalWorkflow;
  decisions: TeamDecisionWorkflow;
  dependencies: TeamWorkflowDependencies;
  duel: TeamDuelWorkflow;
  execution: TeamExecution;
  ledger: TeamLedger;
  members: TeamMemberLifecycle;
  openDecision: (runId: string, decision: TeamDecision) => void;
  poller: TeamRoundPoller;
  recordAgreement: (runId: string, title: string, text: string, votes: string) => void;
}

export class TeamRoundProgression {
  constructor(private readonly parts: TeamRoundProgressionParts) {}

  async step(runId: string): Promise<void> {
    const { execution, ledger, members, poller } = this.parts;
    const run = ledger.get(runId);
    execution.assert(run);
    if (run.next === 'recover') {
      await members.recover(runId);
      return;
    }
    if (run.checkPending) {
      throw new Error('An external check was interrupted before its outcome and next step were recorded. Inspect its possible effects before explicitly retrying.');
    }
    const round = openRound(run);
    if (round) {
      const settled = await poller.poll(runId, round.id);
      execution.assert(ledger.get(runId));
      if (settled) await this.closeRound(runId, settled);
      return;
    }
    if (run.next) await this.executeNext(run, run.next);
  }

  private async closeRound(runId: string, round: TeamRound): Promise<void> {
    const { ledger } = this.parts;
    const run = ledger.get(runId);
    if (round.kind === 'review') {
      await this.closeReviewRound(run, round);
      return;
    }
    ledger.transaction(runId, () => {
      for (const draft of roundFeed(run, round)) ledger.feed(runId, draft);
      if (round.kind === 'design') this.closeDesignRound(run, round);
      if (round.kind === 'build') this.closeBuildRound(run, round);
    });
  }

  private closeRoundAs(runId: string, round: TeamRound, outcome: TeamRound['outcome'] & string): void {
    this.parts.ledger.commit(runId, { outcome, roundId: round.id, type: 'round-closed' });
  }

  private closeDesignRound(run: TeamRun, round: TeamRound): void {
    const { ledger, openDecision } = this.parts;
    const outcome = evaluateDesignRound(run, round);
    if (outcome === 'failed') openDecision(run.id, memberFailedDecision(run, round));
    if (outcome === 'escalated') openDecision(run.id, designDecision(run, round));
    if (outcome === 'continue') {
      ledger.commit(run.id, { next: 'design', type: 'next' });
      ledger.lead(run.id, `Positions are open. Round ${round.number + 1} starts now: answer objections or change position with evidence.`);
    }
    if (outcome === 'agreed') this.agreeOnDesign(run.id, round);
    this.closeRoundAs(run.id, round, outcome);
  }

  private agreeOnDesign(runId: string, round: TeamRound): void {
    const { ledger, openDecision, recordAgreement } = this.parts;
    const run = ledger.get(runId);
    const owner = commonProposal(round, run) ?? round.participants[0];
    const proposal = latestProposal(run, owner);
    const title = proposal?.title ?? 'the design';
    recordAgreement(runId, title, proposal?.summary ?? '', `${round.participants.length} of ${round.participants.length}`);
    if (run.policy === 'every-gate') {
      openDecision(runId, approvalDecision(run, round, title));
      return;
    }
    ledger.commit(runId, { next: 'build', type: 'next' });
  }

  private closeBuildRound(run: TeamRun, round: TeamRound): void {
    const { ledger, openDecision } = this.parts;
    const outcome = evaluateBuildRound(round);
    if (outcome === 'failed') openDecision(run.id, memberFailedDecision(run, round));
    if (outcome === 'escalated') openDecision(run.id, humanDecision(run, round));
    if (outcome === 'done') ledger.commit(run.id, { next: 'check', type: 'next' });
    this.closeRoundAs(run.id, round, outcome);
  }

  private async closeReviewRound(run: TeamRun, round: TeamRound): Promise<void> {
    if (round.comparison) {
      this.closeComparisonRound(run, round);
      return;
    }
    const { approvals, decisions, execution, ledger, openDecision, recordAgreement } = this.parts;
    const outcome = evaluateReviewRound(round);
    const approval = outcome === 'agreed' ? await approvals.approve(run.id, round) : undefined;
    if (outcome === 'agreed' && !approval) return;
    execution.assert(ledger.get(run.id));
    ledger.transaction(run.id, () => {
      for (const draft of roundFeed(run, round)) ledger.feed(run.id, draft);
      if (outcome === 'failed') openDecision(run.id, memberFailedDecision(run, round));
      if (outcome === 'escalated') openDecision(run.id, humanDecision(run, round));
      if (outcome === 'blocked') decisions.requestFix(run.id, 'Review blocked the change.');
      if (approval) {
        ledger.commit(run.id, { approval, sha: approval.snapshotSha, type: 'approved' });
        const votes = `${round.participants.length} of ${round.participants.length}, author excluded`;
        recordAgreement(run.id, 'Code review passed', `All reviewers approved snapshot ${round.snapshotSha?.slice(0, 7)}.`, votes);
        ledger.commit(run.id, { next: 'ship', type: 'next' });
      }
      this.closeRoundAs(run.id, round, outcome);
    });
  }

  private closeComparisonRound(run: TeamRun, round: TeamRound): void {
    const { duel, ledger, openDecision } = this.parts;
    const outcome = evaluateReviewRound(round);
    ledger.transaction(run.id, () => {
      for (const draft of roundFeed(run, round)) ledger.feed(run.id, draft);
      this.closeRoundAs(run.id, round, outcome);
      openDecision(run.id, outcome === 'failed' ? { ...memberFailedDecision(run, round), retryStep: 'check' } : duel.winnerDecision(run, round));
    });
  }

  private async executeNext(run: TeamRun, next: TeamNextStep): Promise<void> {
    if (next === 'design') this.openRoundFor(run.id, 'design', designRounds(run)[0].participants);
    if (next === 'build') this.startBuild(run.id);
    if (next === 'check') await this.runCheck(run.id);
    if (next === 'review') await this.startReview(run.id);
    if (next === 'ship') this.finishReview(run.id);
  }

  private openRoundFor(runId: string, kind: TeamRoundKind, participants: TeamRoleId[], snapshotSha?: string, targetSha?: string): void {
    const { execution, ledger } = this.parts;
    const run = ledger.get(runId);
    execution.assert(run);
    const round = { ...createTeamRound(run, kind, participants, snapshotSha), targetSha };
    const withRound = ledger.commit(runId, { round, type: 'round-opened' });
    if (isTeamRunClosed(withRound)) return;
    for (const member of withRound.members.filter((candidate) => participants.includes(candidate.role))) {
      writeMuxBaseFile(join(member.worktreePath, teamRoundPath(withRound, round.id)), buildRoundFile(withRound, round, member));
    }
    ledger.feed(runId, { kind: 'round', roundId: round.id });
  }

  private startBuild(runId: string): void {
    const { execution, ledger } = this.parts;
    execution.assert(ledger.get(runId));
    ledger.commit(runId, { type: 'approved' });
    ledger.commit(runId, { type: 'check-snapshot' });
    ledger.commit(runId, { stage: 'build', type: 'stage' });
    this.openRoundFor(runId, 'build', teamBuildParticipants(ledger.get(runId)));
  }

  private async runCheck(runId: string): Promise<void> {
    const { approvals, decisions, duel, execution, ledger } = this.parts;
    const run = ledger.get(runId);
    if (run.mode === 'duel' && !run.selectedSourceId) {
      await duel.compare(runId);
      return;
    }
    const result = await approvals.check(runId);
    execution.assert(ledger.get(runId));
    ledger.transaction(runId, () => {
      ledger.commit(runId, { pending: false, type: 'check-execution' });
      if (result === 'failed') decisions.requestFix(runId, 'Checks failed.');
      else ledger.commit(runId, { next: result === 'changed' ? 'check' : 'review', type: 'next' });
    });
  }

  private async startReview(runId: string): Promise<void> {
    const { approvals, execution, ledger } = this.parts;
    if (!approvals.reviewersReady(runId)) return;
    const { reviewers, sha, targetSha } = await approvals.review(runId);
    execution.assert(ledger.get(runId));
    ledger.commit(runId, { stage: 'review', type: 'stage' });
    ledger.lead(runId, `Snapshot ${sha.slice(0, 7)} is frozen for review. The author does not vote.`);
    this.openRoundFor(runId, 'review', reviewers.map((member) => member.role), sha, targetSha);
  }

  private finishReview(runId: string): void {
    const { dependencies, execution, ledger } = this.parts;
    execution.assert(ledger.get(runId));
    if (!ledger.get(runId).approval) throw new Error('A review or waiver certificate is required before shipping');
    ledger.transaction(runId, () => {
      ledger.commit(runId, { type: 'next' });
      ledger.commit(runId, { stage: 'ship', type: 'stage' });
      ledger.commit(runId, { status: 'ready', type: 'status' });
      ledger.feed(runId, { kind: 'final' });
    });
    dependencies.notify('Your team finished. The change is ready for your merge.', ledger.get(runId));
  }
}

import { TEAM_ACCEPT_OPTION, TEAM_SEND_BACK_OPTION, type TeamDecision, type TeamNextStep, type TeamRoleId } from '../../../shared/team-types.js';
import type { TeamLedger } from './TeamLedger.js';
import { FIX_OPTION, fixLimitDecision, fixLimitReason } from './teamDecisions.js';
import { designRounds, latestProposal, memberLabel } from './teamProtocol.js';

export class TeamDecisionWorkflow {
  constructor(
    private readonly ledger: TeamLedger,
    private readonly openDecision: (runId: string, decision: TeamDecision) => void,
    private readonly recordAgreement: (runId: string, title: string, text: string, votes: string) => void,
  ) {}

  requestFix(runId: string, reason: string): void {
    const run = this.ledger.get(runId);
    const max = run.maxFixRounds ?? 2;
    if (run.fixAttempts >= max) {
      this.openDecision(runId, fixLimitDecision(run, fixLimitReason(reason, max)));
      return;
    }
    const attempt = run.fixAttempts + 1;
    this.ledger.commit(runId, { type: 'fix-attempts', value: attempt });
    this.ledger.lead(runId, `${reason} Fix round ${attempt} of ${max} after the initial build.`);
    this.ledger.commit(runId, { next: 'build', type: 'next' });
  }

  apply(runId: string, decision: TeamDecision, optionId: string): void {
    if (optionId === TEAM_SEND_BACK_OPTION) {
      if (decision.kind === 'approval') this.ledger.commit(runId, { type: 'agreement-withdrawn' });
      this.ledger.commit(runId, { type: 'design-floor', value: designRounds(this.ledger.get(runId)).length });
      this.ledger.commit(runId, { next: 'design', type: 'next' });
      return;
    }
    if (decision.kind === 'design') this.adoptProposal(runId, decision, optionId as TeamRoleId);
    if (decision.kind === 'approval') this.ledger.commit(runId, { next: 'build', type: 'next' });
    if (decision.kind === 'fix-limit') this.applyFixLimit(runId, optionId);
    if (decision.kind === 'member-failed') this.retryRound(runId, decision.retryStep);
    if (decision.kind === 'duel-winner' && optionId === 'retry') {
      this.ledger.commit(runId, { type: 'source-selected' });
      this.retryRound(runId, 'check');
    }
  }

  private adoptProposal(runId: string, decision: TeamDecision, owner: TeamRoleId): void {
    const run = this.ledger.get(runId);
    const proposal = latestProposal(run, owner);
    const chosen = decision.options.find((option) => option.id === owner);
    this.recordAgreement(runId, chosen?.title ?? owner, proposal?.summary ?? '', `Your decision ${decision.label}`);
    const round = run.rounds.find((candidate) => candidate.id === decision.roundId);
    for (const role of round?.participants ?? []) {
      if (chosen?.holders.includes(role)) continue;
      this.ledger.commit(runId, { dissent: {
        at: Date.now(), decisionLabel: decision.label, role,
        text: round?.positions[role]?.summary ?? `${memberLabel(run, role)} disagreed.`,
      }, type: 'dissent' });
    }
    this.ledger.commit(runId, { next: 'build', type: 'next' });
  }

  private applyFixLimit(runId: string, optionId: string): void {
    if (optionId === FIX_OPTION) {
      this.ledger.commit(runId, { type: 'fix-attempts', value: 1 });
      this.ledger.commit(runId, { next: 'build', type: 'next' });
    }
    if (optionId === TEAM_ACCEPT_OPTION) this.ledger.commit(runId, { next: 'ship', type: 'next' });
  }

  private retryRound(runId: string, retryStep?: TeamNextStep): void {
    const run = this.ledger.get(runId);
    const next = retryStep ?? run.rounds.at(-1)?.kind ?? (run.mode === 'council' ? 'design' : 'build');
    this.ledger.commit(runId, { pending: false, type: 'check-execution' });
    this.ledger.commit(runId, { step: next, type: 'recovery' });
    this.ledger.commit(runId, { next: 'recover', type: 'next' });
  }
}

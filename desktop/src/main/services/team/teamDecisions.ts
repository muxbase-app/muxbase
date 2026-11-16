import { randomUUID } from 'node:crypto';
import { teamRoleDisplayName } from '../../../shared/team-display.js';
import {
  TEAM_ACCEPT_OPTION,
  TEAM_SEND_BACK_OPTION,
  TEAM_STOP_OPTION,
  type TeamDecision,
  type TeamDecisionOption,
  type TeamRound,
  type TeamRun,
} from '../../../shared/team-types.js';
import { latestProposal, supportGroups } from './teamProtocol.js';

const CONTINUE_OPTION = 'continue';
export const FIX_OPTION = 'fix';
const RETRY_OPTION = 'retry';

const STOP: TeamDecisionOption = { holders: [], id: TEAM_STOP_OPTION, title: 'Stop this run' };

function decisionBase(run: TeamRun, round: TeamRound | undefined) {
  return {
    id: randomUUID(),
    label: `D-${run.decisions.length + 1}`,
    openedAt: Date.now(),
    roundId: round?.id,
    settled: run.agreements.map((agreement) => agreement.text),
  };
}

function proposalOptions(run: TeamRun, round: TeamRound): TeamDecisionOption[] {
  return [...supportGroups(round).entries()].filter(([owner]) => (
    round.participants.includes(owner) && latestProposal(run, owner) !== undefined
  )).map(([owner, holders]) => {
    const proposal = latestProposal(run, owner);
    return {
      cost: proposal?.cost,
      gain: proposal?.gain,
      holders,
      id: owner,
      risk: proposal?.risk,
      summary: proposal?.summary,
      title: proposal?.title ?? owner,
    };
  });
}

export function designDecision(run: TeamRun, round: TeamRound): TeamDecision {
  const flagged = round.participants.map((role) => round.positions[role]?.needsHuman).find(Boolean);
  const options = proposalOptions(run, round);
  return {
    ...decisionBase(run, round),
    kind: 'design',
    options,
    title: flagged ? 'The team needs your decision' : 'The team could not agree. Which way should they go?',
    why: flagged ?? `The team used all its rounds and ${options.length > 1 ? 'still disagrees' : 'still has blocking objections'}.`,
  };
}

export function approvalDecision(run: TeamRun, round: TeamRound, title: string): TeamDecision {
  return {
    ...decisionBase(run, round),
    kind: 'approval',
    options: [
      { holders: round.participants, id: CONTINUE_OPTION, title: 'Approve and build' },
      STOP,
    ],
    title: `Team agreed on ${title}. Start building?`,
    why: 'You asked to approve every gate.',
  };
}

export function fixLimitDecision(run: TeamRun, reason: string): TeamDecision {
  const role = run.members.find((member) => member.paneId === run.selectedSourceId)?.role ?? 'developer';
  const name = teamRoleDisplayName(run.mode, role, 'Developer');
  const writer = run.mode === 'duel' ? name : `the ${name}`;
  return {
    ...decisionBase(run, run.rounds.at(-1)),
    kind: 'fix-limit',
    options: [
      { holders: [], id: FIX_OPTION, title: `Give ${writer} more attempts` },
      { holders: [], id: TEAM_ACCEPT_OPTION, title: 'Accept it as it is' },
      STOP,
    ],
    title: 'The team could not finish this on its own',
    why: reason,
  };
}

export function fixLimitReason(reason: string, attempts: number): string {
  return `${reason} ${attempts} ${attempts === 1 ? 'fix' : 'fixes'} after the initial build ${attempts === 1 ? 'was' : 'were'} not enough.`;
}

export function memberFailedDecision(run: TeamRun, round: TeamRound): TeamDecision {
  return {
    ...decisionBase(run, round),
    kind: 'member-failed',
    options: [{ holders: [], id: RETRY_OPTION, title: 'Retry this round' }, STOP],
    retryStep: round.kind,
    title: 'A team member did not answer',
    why: Object.values(round.failures).join(' '),
  };
}

export function humanDecision(run: TeamRun, round: TeamRound): TeamDecision {
  const reasons = round.participants.flatMap((role) => {
    const reason = round.positions[role]?.needsHuman;
    return reason ? [`${role}: ${reason}`] : [];
  });
  return {
    ...decisionBase(run, round),
    kind: 'member-failed',
    options: [{ holders: [], id: RETRY_OPTION, title: 'Give guidance and retry this round' }, STOP],
    retryStep: round.kind,
    title: 'The team needs your guidance',
    why: `${reasons.join(' ')} Answer in the team message box below, then retry this ${round.kind} round.`,
  };
}

export function stepFailedDecision(run: TeamRun, reason: string): TeamDecision {
  return {
    ...decisionBase(run, undefined),
    kind: 'member-failed',
    options: [{ holders: [], id: RETRY_OPTION, title: 'Try again' }, STOP],
    title: 'The run hit an error',
    why: reason,
  };
}

export function decisionText(decision: TeamDecision, optionId: string, note?: string): string {
  if (optionId === TEAM_SEND_BACK_OPTION) return `Sent back to the team. ${note ?? ''}`.trim();
  if (optionId === TEAM_STOP_OPTION) return 'Stopped this run.';
  const title = decision.options.find((option) => option.id === optionId)?.title ?? optionId;
  return `${title}.${note ? ` ${note}` : ''}`;
}

export function isKnownOption(decision: TeamDecision, optionId: string): boolean {
  if (optionId === TEAM_SEND_BACK_OPTION) return decision.kind === 'design' || decision.kind === 'approval';
  return optionId === TEAM_STOP_OPTION || decision.options.some((option) => option.id === optionId);
}

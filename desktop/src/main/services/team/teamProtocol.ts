import { randomUUID } from 'node:crypto';
import {
  TEAM_MAX_DESIGN_ROUNDS,
  type TeamEvent,
  type TeamMember,
  type TeamPosition,
  type TeamRoleId,
  type TeamRound,
  type TeamRoundKind,
  type TeamRoundOutcome,
  type TeamRun,
  type TeamRunSeed,
  type TeamRunStatus,
} from '../../../shared/team-types.js';

const STOPPING_IGNORED_EVENTS = new Set<TeamEvent['type']>(['decision-opened', 'decision-resolved', 'next', 'round-opened', 'stage']);
const STOPPING_ALLOWED_STATUSES = new Set<TeamRunStatus>(['merged', 'stopped', 'stopping']);

function createRun(seed: TeamRunSeed): TeamRun {
  return {
    ...seed,
    maxFixRounds: seed.maxFixRounds ?? 2,
    mode: seed.mode ?? 'council',
    agreements: [],
    decisions: [],
    designRoundFloor: 0,
    dissent: [],
    feed: [],
    fixAttempts: 0,
    members: [],
    pendingNotes: [],
    rounds: [],
    stage: seed.mode && seed.mode !== 'council' ? 'build' : 'design',
    status: 'starting',
    updatedAt: seed.createdAt,
  };
}

function updateRound(run: TeamRun, roundId: string, change: (round: TeamRound) => TeamRound): TeamRun {
  if (!run.rounds.some((round) => round.id === roundId)) throw new Error(`Team round not found: ${roundId}`);
  return { ...run, rounds: run.rounds.map((round) => (round.id === roundId ? change(round) : round)) };
}

function applyRoundEvent(run: TeamRun, event: TeamEvent, at: number): TeamRun | null {
  switch (event.type) {
    case 'round-opened':
      return { ...run, next: undefined, pendingNotes: [], rounds: [...run.rounds, event.round] };
    case 'delivered':
      return updateRound(run, event.roundId, (round) => ({
        ...round,
        baselines: { ...round.baselines, [event.role]: event.baseline },
        undelivered: round.undelivered.filter((role) => role !== event.role),
      }));
    case 'delivery-attempt':
      return updateRound(run, event.roundId, (round) => ({
        ...round,
        deliveryAttempts: {
          ...round.deliveryAttempts,
          [event.role]: {
            ...(event.state === 'sent' ? round.deliveryAttempts?.[event.role] : undefined),
            at: event.state === 'sent' ? round.deliveryAttempts?.[event.role]?.at ?? at : at,
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            state: event.state,
          },
        },
      }));
    case 'reminded':
      return updateRound(run, event.roundId, (round) => ({ ...round, reminded: [...round.reminded, event.role] }));
    case 'delivery-reconciled':
      return updateRound(run, event.roundId, (round) => {
        const deliveryAttempts = { ...round.deliveryAttempts };
        delete deliveryAttempts[event.role];
        return { ...round, deliveryAttempts };
      });
    case 'position':
      return updateRound(run, event.roundId, (round) => ({
        ...round,
        positions: { ...round.positions, [event.role]: event.position },
      }));
    case 'member-failed':
      return updateRound(run, event.roundId, (round) => ({
        ...round,
        failures: { ...round.failures, [event.role]: event.reason },
      }));
    case 'round-closed':
      return updateRound(run, event.roundId, (round) => ({ ...round, closedAt: at, outcome: event.outcome }));
    default:
      return null;
  }
}

function applyDecisionEvent(run: TeamRun, event: TeamEvent): TeamRun | null {
  switch (event.type) {
    case 'decision-opened':
      return { ...run, decisions: [...run.decisions, event.decision], next: undefined, status: 'waiting' };
    case 'decision-resolved':
      return {
        ...run,
        decisions: run.decisions.map((decision) => (
          decision.id === event.decisionId ? { ...decision, chosen: event.chosen, note: event.note } : decision
        )),
        status: 'running',
      };
    case 'agreement':
      return { ...run, agreements: [...run.agreements, event.agreement] };
    case 'agreement-withdrawn':
      return { ...run, agreements: run.agreements.slice(0, -1) };
    case 'dissent':
      return { ...run, dissent: [...run.dissent, event.dissent] };
    default:
      return null;
  }
}

function replaceMember(members: TeamMember[], member: TeamMember): TeamMember[] {
  if (!members.some((current) => current.role === member.role)) return [...members, member];
  return members.map((current) => current.role === member.role ? member : current);
}

function restoreMemberTuning(run: TeamRun, member: TeamMember): TeamMember {
  if (run.mode !== 'duel' || member.readOnly) return member;
  const side = run.duelSides?.[member.role === 'developer' ? 0 : 1];
  return { ...member, effort: member.effort ?? side?.effort, model: member.model ?? side?.model };
}

function applyMergeHook(run: TeamRun, event: Extract<TeamEvent, { type: 'merge-hook' }>): TeamRun {
  const intent = run.mergeIntent;
  if (!intent || run.status !== 'merged' || intent.state !== 'cleaned' || intent.operationId !== event.operationId) {
    throw new Error('A hook outcome must belong to its durably completed Team publication.');
  }
  if (intent.hook && (intent.hook.state !== 'running' || event.hook.state === 'running')) {
    throw new Error('The Team publication hook has already been reserved or settled.');
  }
  if (!intent.hook && !['running', 'unknown'].includes(event.hook.state)) {
    throw new Error('The Team publication hook must be reserved before recording its outcome.');
  }
  return { ...run, mergeIntent: { ...intent, hook: event.hook } };
}

function applyRunEvent(run: TeamRun, event: TeamEvent): TeamRun {
  switch (event.type) {
    case 'member':
      return { ...run, members: replaceMember(run.members, restoreMemberTuning(run, event.member)) };
    case 'feed':
      return { ...run, feed: [...run.feed, event.item] };
    case 'next':
      return { ...run, next: event.next };
    case 'stage':
      return { ...run, stage: event.stage };
    case 'note':
      return { ...run, pendingNotes: [...run.pendingNotes, event.text] };
    case 'approved':
      return { ...run, approval: event.approval, approvedSnapshot: event.approval?.snapshotSha ?? event.sha };
    case 'merge-intent':
      return { ...run, mergeIntent: event.intent };
    case 'merge-hook':
      return applyMergeHook(run, event);
    case 'check-snapshot':
      return { ...run, checkedSnapshot: event.sha };
    case 'check-execution':
      return { ...run, checkPending: event.pending };
    case 'recovery':
      return { ...run, recoveryStep: event.step };
    case 'usage':
      return {
        ...run,
        tokenUsage: (run.tokenUsage ?? 0) + event.tokens,
        usageCheckpoints: event.checkpoints ? { ...event.checkpoints } : run.usageCheckpoints,
        usageSourceUpdatedAt: event.sourceUpdatedAt ?? run.usageSourceUpdatedAt,
      };
    case 'fix-attempts':
      return { ...run, fixAttempts: event.value };
    case 'design-floor':
      return { ...run, designRoundFloor: event.value };
    case 'duel-snapshots':
      return { ...run, duelSnapshots: event.snapshots };
    case 'source-selected':
      return { ...run, selectedSourceId: event.paneId, approval: undefined, approvedSnapshot: undefined, checkedSnapshot: undefined };
    case 'limit-pause':
      return { ...run, limitPause: event.pause };
    case 'limits-extended':
      return { ...run, limits: event.limits };
    case 'resume-decision':
      return { ...run, resumeDecisionId: event.decisionId };
    case 'status':
      return { ...run, error: event.error, status: event.status };
    default:
      return run;
  }
}

export function isTeamRunClosed(run: TeamRun): boolean {
  return run.status === 'merged' || run.status === 'stopped';
}

function isIgnoredDuringClosure(run: TeamRun, event: TeamEvent): boolean {
  if (event.type === 'merge-hook') return false;
  if (isTeamRunClosed(run)) {
    if (event.type === 'status' && event.status === run.status) return false;
    if (event.type === 'merge-intent' && run.status === 'merged'
      && run.mergeIntent?.state === 'published' && event.intent?.state === 'cleaned'
      && event.intent.operationId === run.mergeIntent.operationId) return false;
    return event.type !== 'feed';
  }
  if (run.status !== 'stopping') return false;
  if (event.type === 'status') return !STOPPING_ALLOWED_STATUSES.has(event.status);
  return STOPPING_IGNORED_EVENTS.has(event.type);
}

export function reduceTeamEvent(run: TeamRun | null, event: TeamEvent, at: number): TeamRun {
  if (event.type === 'created') {
    if (run) throw new Error('Team run already created');
    return createRun(event.seed);
  }
  if (!run) throw new Error(`Team event ${event.type} arrived before the run was created`);
  if (isIgnoredDuringClosure(run, event)) return run;
  const next = applyRoundEvent(run, event, at) ?? applyDecisionEvent(run, event) ?? applyRunEvent(run, event);
  return { ...next, updatedAt: at };
}

export function designRounds(run: TeamRun): TeamRound[] {
  return run.rounds.filter((round) => round.kind === 'design');
}

export function openRound(run: TeamRun): TeamRound | undefined {
  return run.rounds.find((round) => round.closedAt === undefined);
}

function currentSupports(run: TeamRun, role: TeamRoleId): TeamRoleId {
  const previous = designRounds(run).filter((round) => round.closedAt !== undefined).at(-1)?.positions[role];
  return previous?.supports ?? role;
}

export function latestProposal(run: TeamRun, owner: TeamRoleId) {
  for (const round of [...designRounds(run)].reverse()) {
    const proposal = round.positions[owner]?.proposal;
    if (proposal) return proposal;
  }
  return undefined;
}

export function supportGroups(round: TeamRound): Map<TeamRoleId, TeamRoleId[]> {
  const groups = new Map<TeamRoleId, TeamRoleId[]>();
  for (const role of round.participants) {
    const owner = round.positions[role]?.supports ?? role;
    groups.set(owner, [...(groups.get(owner) ?? []), role]);
  }
  return groups;
}

function hasBlockingObjection(position: TeamPosition | undefined): boolean {
  return position?.objections.some((objection) => objection.severity === 'blocking') ?? false;
}

function acceptableTo(round: TeamRound, role: TeamRoleId): TeamRoleId[] {
  const position = round.positions[role];
  if (!position) return [];
  return [...position.acceptable, ...(position.supports ? [position.supports] : []), ...(position.proposal ? [role] : [])];
}

function isProposalOwner(run: TeamRun | undefined, round: TeamRound, owner: TeamRoleId): boolean {
  return round.participants.includes(owner)
    && (round.positions[owner]?.proposal !== undefined || (run !== undefined && latestProposal(run, owner) !== undefined));
}

export function commonProposal(round: TeamRound, run?: TeamRun): TeamRoleId | undefined {
  const shared = round.participants.filter((owner) => (
    isProposalOwner(run, round, owner)
    && round.participants.every((role) => acceptableTo(round, role).includes(owner))
  ));
  const groups = supportGroups(round);
  return [...shared].sort((left, right) => (groups.get(right)?.length ?? 0) - (groups.get(left)?.length ?? 0))[0];
}

export function evaluateDesignRound(run: TeamRun, round: TeamRound): TeamRoundOutcome {
  if (Object.keys(round.failures).length > 0) return 'failed';
  const positions = round.participants.map((role) => round.positions[role]);
  if (positions.some((position) => position?.needsHuman)) return 'escalated';
  const segment = designRounds(run).filter((candidate) => candidate.number > run.designRoundFloor);
  const isBlindRound = run.designRoundFloor === 0 && round.number === 1;
  if (isBlindRound) return 'continue';
  const agreed = commonProposal(round, run) !== undefined && !positions.some(hasBlockingObjection);
  if (agreed) return 'agreed';
  return segment.length >= TEAM_MAX_DESIGN_ROUNDS ? 'escalated' : 'continue';
}

export function evaluateReviewRound(round: TeamRound): TeamRoundOutcome {
  if (Object.keys(round.failures).length > 0) return 'failed';
  const positions = round.participants.map((role) => round.positions[role]);
  if (positions.some((position) => position?.needsHuman)) return 'escalated';
  const blocked = positions.some((position) => position?.verdict !== 'approve' || hasBlockingObjection(position));
  return blocked ? 'blocked' : 'agreed';
}

export function evaluateBuildRound(round: TeamRound): TeamRoundOutcome {
  if (Object.keys(round.failures).length > 0) return 'failed';
  const positions = round.participants.map((role) => round.positions[role]);
  if (positions.some((position) => position?.needsHuman)) return 'escalated';
  return positions.every(Boolean) && positions.length > 0 ? 'done' : 'failed';
}

export function normalizeSupport(
  run: TeamRun,
  round: TeamRound,
  role: TeamRoleId,
  position: TeamPosition,
): TeamPosition {
  if (round.kind !== 'design') return position;
  const previous = currentSupports(run, role);
  const requested = position.supports ?? previous;
  const changesSide = requested !== previous;
  const justified = !changesSide || position.evidence.length > 0;
  const ownsProposal = (owner: TeamRoleId) => (
    isProposalOwner(run, round, owner) || (owner === role && position.proposal !== undefined)
  );
  const fallback = ownsProposal(previous) ? previous : undefined;
  const supports = ownsProposal(requested) && justified ? requested : fallback;
  const acceptable = position.acceptable.filter(ownsProposal);
  return { ...position, acceptable, supports };
}

export function createTeamRound(
  run: TeamRun,
  kind: TeamRoundKind,
  participants: TeamRoleId[],
  snapshotSha?: string,
): TeamRound {
  return {
    baselines: {},
    failures: {},
    id: randomUUID().slice(0, 8),
    kind,
    notes: run.pendingNotes,
    number: run.rounds.filter((round) => round.kind === kind).length + 1,
    openedAt: Date.now(),
    participants,
    positions: {},
    reminded: [],
    snapshotSha,
    undelivered: participants,
  };
}

export function teamDeveloper(run: TeamRun): TeamMember {
  const developer = run.members.find((member) => run.mode === 'duel' ? member.paneId === run.selectedSourceId && !member.readOnly : member.role === 'developer');
  if (!developer) throw new Error('This team has no Developer');
  return developer;
}

export function memberLabel(run: TeamRun, role: TeamRoleId): string {
  return run.members.find((member: TeamMember) => member.role === role)?.label ?? role;
}

import { teamRoleDisplayName } from '../../../shared/team-display';
import {
  TEAM_SEND_BACK_OPTION,
  type TeamDecision,
  type TeamMember,
  type TeamPosition,
  type TeamRoleId,
  type TeamRound,
  type TeamRoundKind,
  type TeamRun,
  type TeamRunStatus,
} from '../../../shared/team-types';
import { TEAM_MODE_OPTIONS } from './teamModeOptions';

export const ROLE_MARKS: Record<TeamRoleId, string> = {
  architect: 'AR',
  developer: 'DV',
  domain: 'DX',
  tester: 'TS',
};

const PAIR_ROLE_MARKS = { ...ROLE_MARKS, developer: 'WR', tester: 'RV' };
const DUEL_ROLE_MARKS = { ...ROLE_MARKS, architect: 'WB', developer: 'WA', tester: 'CM' };

export const ROLE_COLORS: Record<TeamRoleId, string> = {
  architect: 'var(--team-architect)',
  developer: 'var(--team-developer)',
  domain: 'var(--team-domain)',
  tester: 'var(--team-tester)',
};

const ROLE_NAMES: Record<TeamRoleId, string> = {
  architect: 'Architect',
  developer: 'Developer',
  domain: 'Domain expert',
  tester: 'Tester',
};

const STEPS = ['design', 'build', 'checks', 'review', 'ship'] as const;
type StepId = (typeof STEPS)[number];
const STEP_LABELS: Record<StepId, string> = {
  build: 'Build',
  checks: 'Checks',
  design: 'Design',
  review: 'Review',
  ship: 'Ship',
};
const CURRENT_STEP_STATES: Partial<Record<TeamRunStatus, GateState>> = {
  failed: 'failed',
  merged: 'done',
  ready: 'waiting',
  stopped: 'stopped',
  stopping: 'stopped',
  waiting: 'waiting',
};

export type GateState = 'current' | 'done' | 'failed' | 'pending' | 'stopped' | 'waiting';

export interface GateView {
  current: boolean;
  id: string;
  label: string;
  state: GateState;
}

export interface BraidCluster {
  label: string;
  members: TeamRoleId[];
  y: number;
}

export interface BraidColumn {
  clusters: BraidCluster[];
  fault: boolean;
  label: string;
}

const DUEL_STEP_IDS = ['build', 'compare', 'choose', 'review', 'ship'];
const BRAID_TOP = 40;
const BRAID_BOTTOM = 160;

export function memberFor(run: TeamRun, role: TeamRoleId): TeamMember | undefined {
  return run.members.find((member) => member.role === role);
}

export function roleName(run: TeamRun, role: TeamRoleId): string {
  return teamRoleDisplayName(run.mode, role, memberFor(run, role)?.label ?? ROLE_NAMES[role]);
}

export function roleMark(run: TeamRun, role: TeamRoleId): string {
  if (run.mode === 'pair') return PAIR_ROLE_MARKS[role];
  if (run.mode === 'duel') return DUEL_ROLE_MARKS[role];
  return ROLE_MARKS[role];
}

function currentGateState(run: TeamRun): GateState {
  return CURRENT_STEP_STATES[run.status] ?? 'current';
}

function latestRound(run: TeamRun, kind: TeamRoundKind): TeamRound | undefined {
  return run.rounds.filter((round) => round.kind === kind).at(-1);
}

function currentStep(run: TeamRun): StepId {
  if (run.stage !== 'build') return run.stage;
  const checking = Boolean(latestRound(run, 'build')?.closedAt) || run.checkPending || run.next === 'check';
  return checking ? 'checks' : 'build';
}

function stepState(index: number, current: number, run: TeamRun): GateState {
  if (index < current) return 'done';
  return index === current ? currentGateState(run) : 'pending';
}

export function gateViews(run: TeamRun): GateView[] {
  if (run.mode === 'duel') return duelGateViews(run);
  const steps: readonly StepId[] = run.mode === 'pair' ? STEPS.filter((step) => step !== 'design') : STEPS;
  const current = steps.indexOf(currentStep(run));
  return steps.map((step, index) => ({
    current: index === current,
    id: step,
    label: STEP_LABELS[step],
    state: stepState(index, current, run),
  }));
}

function duelGateViews(run: TeamRun): GateView[] {
  const compared = run.rounds.some((round) => round.comparison && round.closedAt);
  const selected = Boolean(run.selectedSourceId);
  const afterBuild = run.stage === 'review' || run.stage === 'ship';
  const reached = [true, afterBuild, compared, selected, run.stage === 'ship'];
  const current = reached.lastIndexOf(true);
  return ['Build both', 'Compare', 'Your choice', 'Review', 'Ship'].map((label, index) => ({
    current: index === current,
    id: DUEL_STEP_IDS[index],
    label,
    state: stepState(index, current, run),
  }));
}

export function activeDecision(run: TeamRun): TeamDecision | undefined {
  if (run.status !== 'waiting') return undefined;
  return run.decisions.filter((candidate) => !candidate.chosen).at(-1);
}

export function openRound(run: TeamRun): TeamRound | undefined {
  const round = run.rounds.at(-1);
  return round && !round.closedAt ? round : undefined;
}

export function pendingRoles(round: TeamRound): TeamRoleId[] {
  return round.participants.filter((role) => !round.positions[role] && !round.failures[role]);
}

export function canStopRun(run: TeamRun): boolean {
  if (run.mergeIntent) return false;
  if (run.status === 'stopping') return Boolean(run.error);
  return isRunLive(run) || run.status === 'ready' || run.status === 'failed';
}

export function canRetryPublication(run: TeamRun): boolean {
  return run.status === 'failed' && Boolean(run.mergeIntent);
}

export function decisionOutcome(decision: TeamDecision): string {
  if (decision.chosen === TEAM_SEND_BACK_OPTION) return 'Sent back to the team';
  return decision.options.find((option) => option.id === decision.chosen)?.title ?? 'Stopped';
}

export function isFailureDecision(run: TeamRun, decision: TeamDecision): boolean {
  if (decision.kind === 'fix-limit') return true;
  if (decision.kind !== 'member-failed') return false;
  const round = run.rounds.find((candidate) => candidate.id === decision.roundId);
  return !round?.participants.some((role) => round.positions[role]?.needsHuman);
}

const RECOVERY_COPY: Partial<Record<TeamRunStatus, readonly [string, string]>> = {
  failed: ['The run stopped on an error', 'The team could not continue. Its worktrees are left as they were, so no work is lost.'],
  merged: ['Merged, but a follow-up step needs attention', 'Your change merged. A step after the merge did not finish cleanly.'],
  stopping: ['The run did not stop cleanly', 'Some agents or checks did not stop. Writer work is preserved. You can try stopping again.'],
};
const PUBLICATION_COPY = [
  'Publishing the merge did not finish',
  'Git stopped partway through publishing the reviewed change, and its files are preserved. Retry publishing to let MuxBase finish it safely. If it fails again, inspect the project folder and the journal named in Details and finish the merge by hand.',
] as const;
const DEFAULT_RECOVERY_COPY = ['The team needs your attention', 'The team hit a problem it could not resolve on its own.'] as const;

export function recoveryCopy(run: TeamRun): readonly [string, string] {
  if (canRetryPublication(run)) return PUBLICATION_COPY;
  return RECOVERY_COPY[run.status] ?? DEFAULT_RECOVERY_COPY;
}

function proposalTitle(run: TeamRun, owner: TeamRoleId): string {
  const rounds = run.rounds.filter((round) => round.kind === 'design').reverse();
  for (const round of rounds) {
    const title = round.positions[owner]?.proposal?.title;
    if (title) return title;
  }
  return roleName(run, owner);
}

function spreadY(count: number, index: number): number {
  if (count === 1) return (BRAID_TOP + BRAID_BOTTOM) / 2;
  return BRAID_TOP + (index * (BRAID_BOTTOM - BRAID_TOP)) / (count - 1);
}

function groupRound(run: TeamRun, round: TeamRound): Map<string, TeamRoleId[]> {
  const groups = new Map<string, TeamRoleId[]>();
  for (const role of round.participants) {
    const position = round.positions[role];
    if (!position) continue;
    const key = positionGroup(run, round, role, position);
    groups.set(key, [...(groups.get(key) ?? []), role]);
  }

  function positionGroup(run: TeamRun, round: TeamRound, role: TeamRoleId, position: TeamPosition): string {
    if (round.comparison) return position.supports ? `Recommends ${roleName(run, position.supports)}` : 'No recommendation';
    if (round.kind === 'review') return position.verdict === 'approve' ? 'Approve' : 'Block';
    return proposalTitle(run, position.supports ?? role);
  }
  return groups;
}

function toClusters(groups: Map<string, TeamRoleId[]>): BraidCluster[] {
  return [...groups.entries()].map(([label, members], index) => ({
    label,
    members,
    y: spreadY(groups.size, index),
  }));
}

function resolvedDecision(run: TeamRun, round: TeamRound): TeamDecision | undefined {
  return run.decisions.find((decision) => decision.roundId === round.id && decision.kind === 'design');
}

function decisionColumn(run: TeamRun, round: TeamRound, decision: TeamDecision): BraidColumn {
  const chosen = decision.options.find((option) => option.id === decision.chosen);
  return {
    clusters: [{ label: chosen?.title ?? 'Sent back', members: round.participants, y: 100 }],
    fault: false,
    label: 'You',
  };
}

export function braidColumns(run: TeamRun, kind: TeamRoundKind): BraidColumn[] {
  const rounds = run.rounds.filter((round) => round.kind === kind && round.closedAt);
  const columns = rounds.flatMap((round, index): BraidColumn[] => {
    const decision = resolvedDecision(run, round);
    const stuck = round.outcome === 'escalated' && !decision?.chosen;
    const column = { clusters: toClusters(groupRound(run, round)), fault: stuck, label: index === 0 ? 'R1 sealed' : `R${index + 1}` };
    return decision?.chosen ? [column, decisionColumn(run, round, decision)] : [column];
  });
  return columns;
}

export function braidKinds(run: TeamRun): TeamRoundKind[] {
  const kinds: TeamRoundKind[] = ['design', 'review'];
  return kinds.filter((kind) => run.rounds.some((round) => round.kind === kind && round.closedAt));
}

export function roundQuestion(round: TeamRound): string {
  if (round.comparison) return 'How do the two writer snapshots compare? You choose the winner.';
  if (round.kind === 'review') return `Is snapshot ${round.snapshotSha?.slice(0, 7)} safe to merge?`;
  if (round.kind === 'build') return 'Implement the brief and report the checks.';
  return round.number === 1 ? 'How should we build this?' : 'Which proposal should we build?';
}

export function contestedItems(run: TeamRun): string[] {
  const open = run.decisions.filter((decision) => !decision.chosen).map((decision) => decision.title);
  const last = [...run.rounds].reverse().find((round) => round.closedAt);
  if (!last || last.outcome === 'agreed' || last.outcome === 'done') return open;
  const objections = last.participants.flatMap((role) => last.positions[role]?.objections ?? [])
    .filter((objection) => objection.severity === 'blocking')
    .map((objection) => objection.claim);
  return [...open, ...objections];
}

export function isRunLive(run: TeamRun): boolean {
  return ['running', 'starting', 'stopping', 'waiting'].includes(run.status);
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function runStats(run: TeamRun): string[] {
  return [
    run.rounds.length > 0 ? count(run.rounds.length, 'round', 'rounds') : '',
    run.decisions.length > 0 ? count(run.decisions.length, 'decision by you', 'decisions by you') : '',
    run.dissent.length > 0 ? `${run.dissent.length} dissent kept` : '',
  ].filter(Boolean);
}

export function modeLabel(run: TeamRun): string | undefined {
  return TEAM_MODE_OPTIONS.find((option) => option.value === (run.mode ?? 'council'))?.label;
}

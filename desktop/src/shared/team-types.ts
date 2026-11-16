import type { AgentName } from 'muxbase/core';
import type { PaneDuelCreateRequest } from './ipc-types.js';
import type { TeamMode } from './team-settings.js';

export const TEAM_ROLE_IDS = ['architect', 'developer', 'tester', 'domain'] as const;
export const TEAM_MAX_DESIGN_ROUNDS = 3;
export const TEAM_DEFAULT_TOKEN_BUDGET = 1_000_000;
export const TEAM_DEFAULT_DURATION_MS = 60 * 60 * 1000;
export const TEAM_MAX_ACTIVE_RUNS = 3;
export const TEAM_ACCEPT_OPTION = 'accept';
export const TEAM_EXTEND_OPTION = 'extend';
export const TEAM_SEND_BACK_OPTION = 'send-back';
export const TEAM_STOP_OPTION = 'stop';

export type TeamRoleId = (typeof TEAM_ROLE_IDS)[number];
export type TeamPolicy = 'every-gate' | 'when-stuck';
export type TeamStage = 'design' | 'build' | 'review' | 'ship';
export type TeamRunStatus = 'failed' | 'merged' | 'ready' | 'running' | 'starting' | 'stopped' | 'stopping' | 'waiting';
export type TeamRoundKind = 'build' | 'design' | 'review';
export type TeamRoundOutcome = 'agreed' | 'blocked' | 'continue' | 'done' | 'escalated' | 'failed';
export type TeamNextStep = 'build' | 'check' | 'design' | 'recover' | 'review' | 'ship';
type TeamDecisionKind = 'approval' | 'design' | 'duel-winner' | 'fix-limit' | 'limit' | 'member-failed';
type TeamFeedLane = 'agreed' | 'contested' | 'working';

export interface TeamMemberConfig {
  agent: AgentName;
  domain?: string;
  effort?: string;
  model?: string;
  role: TeamRoleId;
}

export interface TeamRunLimits {
  maxDurationMs: number;
  maxTokens: number;
}

export interface TeamApproval {
  at: number;
  checkedSnapshot?: string;
  decisionId?: string;
  kind: 'review' | 'waiver';
  reason?: string;
  snapshotSha: string;
  sourcePaneId?: string;
  targetSha: string;
}

export interface TeamDuelSnapshot {
  checkedSnapshot?: string;
  checksPassed: boolean;
  paneId: string;
  snapshotSha: string;
}

interface TeamLimitPause {
  at: number;
  pendingDecisionId?: string;
  quiesced: boolean;
  reason: string;
  resumeStep: TeamNextStep;
}

export interface TeamMember extends TeamMemberConfig {
  label: string;
  paneId: string;
  readOnly: boolean;
  worktreePath: string;
}

interface TeamProposal {
  cost: string;
  gain: string;
  risk: string;
  summary: string;
  title: string;
}

interface TeamObjection {
  claim: string;
  evidence: string[];
  severity: 'blocking' | 'minor';
}

interface TeamResponse {
  evidence: string[];
  kind: 'concede' | 'rebut';
  text: string;
  to: TeamRoleId;
}

export interface TeamPosition {
  acceptable: TeamRoleId[];
  evidence: string[];
  needsHuman?: string;
  objections: TeamObjection[];
  proposal?: TeamProposal;
  responses: TeamResponse[];
  summary: string;
  supports?: TeamRoleId;
  verdict?: 'approve' | 'block';
}

export interface TeamRound {
  baselines: Partial<Record<TeamRoleId, number>>;
  closedAt?: number;
  comparison?: boolean;
  candidateSnapshots?: Partial<Record<TeamRoleId, TeamDuelSnapshot>>;
  deliveryAttempts?: Partial<Record<TeamRoleId, {
    at: number;
    sessionId?: string;
    state: 'pending' | 'sent';
  }>>;
  failures: Partial<Record<TeamRoleId, string>>;
  id: string;
  kind: TeamRoundKind;
  notes: string[];
  number: number;
  openedAt: number;
  outcome?: TeamRoundOutcome;
  participants: TeamRoleId[];
  positions: Partial<Record<TeamRoleId, TeamPosition>>;
  reminded: TeamRoleId[];
  targetSha?: string;
  snapshotSha?: string;
  undelivered: TeamRoleId[];
}

export interface TeamDecisionOption {
  cost?: string;
  gain?: string;
  holders: TeamRoleId[];
  id: string;
  risk?: string;
  summary?: string;
  title: string;
}

export interface TeamDecision {
  chosen?: string;
  id: string;
  kind: TeamDecisionKind;
  label: string;
  note?: string;
  openedAt: number;
  options: TeamDecisionOption[];
  retryStep?: TeamNextStep;
  roundId?: string;
  settled: string[];
  title: string;
  why: string;
}

interface TeamAgreement {
  at: number;
  source: string;
  text: string;
}

interface TeamDissent {
  at: number;
  decisionLabel: string;
  role: TeamRoleId;
  text: string;
}

export type TeamFeedItem = (
  | { kind: 'agreed'; text: string; title: string; votes: string }
  | { command: string; kind: 'check'; output?: string; passed: boolean }
  | { decisionId: string; kind: 'decision' }
  | { kind: 'final' }
  | { kind: 'human'; text: string }
  | { kind: 'lead'; text: string }
  | {
    evidence: string[];
    kind: 'message';
    label: string;
    reply: boolean;
    role: TeamRoleId;
    text: string;
  }
  | { kind: 'round'; roundId: string }
) & { at: number; id: string; lane?: TeamFeedLane };

interface TeamMergeHook {
  at: number;
  error?: string;
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
}

export interface TeamMergeIntent {
  approval: TeamApproval;
  hook?: TeamMergeHook;
  operationId: string;
  sourcePaneId: string;
  sourceSha: string;
  state: 'prepared' | 'published' | 'cleaned';
  targetRef: string;
  targetSha: string;
}

export interface TeamRun {
  agreements: TeamAgreement[];
  approvedSnapshot?: string;
  approval?: TeamApproval;
  baseSha: string;
  brief: string;
  checkCommand?: string;
  checkedSnapshot?: string;
  checkPending?: boolean;
  createdAt: number;
  decisions: TeamDecision[];
  designRoundFloor: number;
  dissent: TeamDissent[];
  duelSides?: PaneDuelCreateRequest['sides'];
  duelSnapshots?: Partial<Record<TeamRoleId, TeamDuelSnapshot>>;
  error?: string;
  feed: TeamFeedItem[];
  fixAttempts: number;
  id: string;
  limits?: TeamRunLimits;
  limitPause?: TeamLimitPause;
  members: TeamMember[];
  mergeIntent?: TeamMergeIntent;
  maxFixRounds?: number;
  mode?: TeamMode;
  next?: TeamNextStep;
  pendingNotes: string[];
  plannedMembers?: TeamMemberConfig[];
  policy: TeamPolicy;
  projectRoot: string;
  recoveryStep?: TeamNextStep;
  resumeDecisionId?: string;
  revision?: number;
  rounds: TeamRound[];
  selectedSourceId?: string;
  stage: TeamStage;
  status: TeamRunStatus;
  title: string;
  tokenUsage?: number;
  usageCheckpoints?: Record<string, number>;
  usageSourceUpdatedAt?: number;
  updatedAt: number;
}

export type TeamRunSeed = Pick<
  TeamRun,
  'baseSha' | 'brief' | 'checkCommand' | 'createdAt' | 'id' | 'limits' | 'plannedMembers' | 'policy' | 'projectRoot' | 'title'
  | 'duelSides' | 'maxFixRounds' | 'mode'
>;

export type TeamEvent =
  | { seed: TeamRunSeed; type: 'created' }
  | { member: TeamMember; type: 'member' }
  | { round: TeamRound; type: 'round-opened' }
  | { baseline: number; role: TeamRoleId; roundId: string; type: 'delivered' }
  | { role: TeamRoleId; roundId: string; sessionId?: string; state: 'pending' | 'sent'; type: 'delivery-attempt' }
  | { role: TeamRoleId; roundId: string; type: 'delivery-reconciled' }
  | { role: TeamRoleId; roundId: string; type: 'reminded' }
  | { position: TeamPosition; role: TeamRoleId; roundId: string; type: 'position' }
  | { reason: string; role: TeamRoleId; roundId: string; type: 'member-failed' }
  | { outcome: TeamRoundOutcome; roundId: string; type: 'round-closed' }
  | { item: TeamFeedItem; type: 'feed' }
  | { next?: TeamNextStep; type: 'next' }
  | { stage: TeamStage; type: 'stage' }
  | { decision: TeamDecision; type: 'decision-opened' }
  | { chosen: string; decisionId: string; note?: string; type: 'decision-resolved' }
  | { text: string; type: 'note' }
  | { agreement: TeamAgreement; type: 'agreement' }
  | { type: 'agreement-withdrawn' }
  | { dissent: TeamDissent; type: 'dissent' }
  | { approval?: TeamApproval; sha?: string; type: 'approved' }
  | { intent?: TeamMergeIntent; type: 'merge-intent' }
  | { hook: TeamMergeHook; operationId: string; type: 'merge-hook' }
  | { sha?: string; type: 'check-snapshot' }
  | { pending: boolean; type: 'check-execution' }
  | { step?: TeamNextStep; type: 'recovery' }
  | { checkpoints?: Record<string, number>; sourceUpdatedAt?: number; tokens: number; type: 'usage' }
  | { type: 'fix-attempts'; value: number }
  | { type: 'design-floor'; value: number }
  | { snapshots?: Partial<Record<TeamRoleId, TeamDuelSnapshot>>; type: 'duel-snapshots' }
  | { paneId?: string; type: 'source-selected' }
  | { pause?: TeamLimitPause; type: 'limit-pause' }
  | { limits: TeamRunLimits; type: 'limits-extended' }
  | { decisionId?: string; type: 'resume-decision' }
  | { error?: string; status: TeamRunStatus; type: 'status' };

export interface TeamStartRequest {
  brief: string;
  checkCommand?: string;
  duelSides?: PaneDuelCreateRequest['sides'];
  limits?: TeamRunLimits;
  maxFixRounds?: number;
  members?: TeamMemberConfig[];
  mode?: TeamMode;
  policy?: TeamPolicy;
}

export interface TeamStartResponse {
  error?: string;
  run?: TeamRun;
  success: boolean;
}

export interface TeamDecideRequest {
  decisionId: string;
  extension?: TeamRunLimits;
  note?: string;
  optionId: string;
  runId: string;
}

export interface TeamNoteRequest {
  runId: string;
  text: string;
}

export interface TeamRunRequest {
  runId: string;
}

export interface TeamFinishRequest {
  outcome: 'merged' | 'stopped';
  runId: string;
}

export interface TeamActionResponse {
  error?: string;
  success: boolean;
}

export interface TeamPrepareMergeResponse extends TeamActionResponse {
  paneId?: string;
}

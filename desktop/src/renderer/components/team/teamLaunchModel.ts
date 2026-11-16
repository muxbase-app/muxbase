import type { AgentName } from 'muxbase/core';
import type { TeamSettingsDefaults } from '../../../shared/team-settings';
import type { TeamMemberConfig, TeamRoleId, TeamStartRequest } from '../../../shared/team-types';
import type { TeamLaunchDraft } from './useTeamLaunchDraft';

const MINUTE_MS = 60_000;

export interface RosterRow extends TeamMemberConfig {
  enabled: boolean;
}

export function preferredAgent(available: AgentName[], preferred: AgentName, excluded: AgentName[] = []): AgentName | undefined {
  return available.find((agent) => agent === preferred && !excluded.includes(agent))
    ?? available.find((agent) => !excluded.includes(agent));
}

export function initialRoster(settings: TeamSettingsDefaults): RosterRow[] {
  const roles: TeamRoleId[] = ['developer', 'architect', 'tester', 'domain'];
  return roles.map((role) => {
    const agent = role === 'developer' ? settings.teamWriterAgent : settings.teamReviewerAgent;
    return { agent, enabled: role === 'developer' || settings.teamCouncilRoles.some((item) => item === role), role };
  });
}

export function runMembers(
  mode: TeamStartRequest['mode'],
  writer: AgentName | undefined,
  reviewer: AgentName | undefined,
  secondWriter: AgentName | undefined,
  rows: RosterRow[],
  domain: string,
): TeamMemberConfig[] {
  if (mode === 'council') return rows.filter((row) => row.enabled).map(({ agent, role }) => ({
    agent, role, ...(role === 'domain' && domain.trim() ? { domain: domain.trim() } : {}),
  }));
  if (!writer || !reviewer) return [];
  const members: TeamMemberConfig[] = [{ agent: writer, role: 'developer' }];
  if (mode === 'duel' && secondWriter) members.push({ agent: secondWriter, role: 'architect' });
  members.push({ agent: reviewer, role: 'tester' });
  return members;
}

export interface TeamLaunchReadiness {
  adaptersEnabled: boolean;
  agentsError: string | null;
  all: AgentName[];
  brief: string;
  draft: TeamLaunchDraft | null;
  members: TeamMemberConfig[];
  readers: AgentName[];
}

export type TeamLaunchSection = 'guardrails' | 'team';

export interface TeamLaunchBlocker {
  message: string;
  section?: TeamLaunchSection;
}

export type TeamLimitField = 'maxFixRounds' | 'maxMinutes' | 'maxTokens';

const isIntegerIn = (value: string, min: number, max: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max;
};

export function invalidLimits(draft: TeamLaunchDraft): TeamLimitField[] {
  const invalid: TeamLimitField[] = [];
  if (!isIntegerIn(draft.maxFixRounds, 1, 5)) invalid.push('maxFixRounds');
  if (!isIntegerIn(draft.maxTokens, 1, Number.MAX_SAFE_INTEGER)) invalid.push('maxTokens');
  if (!isIntegerIn(draft.maxMinutes, 1, 1440)) invalid.push('maxMinutes');
  return invalid;
}

function hasValidMembers(draft: TeamLaunchDraft, members: TeamMemberConfig[], all: AgentName[], readers: AgentName[]): boolean {
  const canWrite = (member: TeamMemberConfig) => member.role === 'developer' || (draft.mode === 'duel' && member.role === 'architect');
  return members.some((member) => member.role === 'developer')
    && members.some((member) => member.role !== 'developer')
    && (draft.mode !== 'duel' || Boolean(draft.secondWriter))
    && members.every((member) => (canWrite(member) ? all : readers).includes(member.agent));
}

export function hasDistinctDuelSides(draft: TeamLaunchDraft): boolean {
  return draft.writer !== draft.secondWriter
    || draft.writerTuning.model !== draft.secondWriterTuning.model
    || draft.writerTuning.effort !== draft.secondWriterTuning.effort;
}

export function launchBlocker({ adaptersEnabled, agentsError, all, brief, draft, members, readers }: TeamLaunchReadiness): TeamLaunchBlocker | undefined {
  if (agentsError) return { message: 'Could not load agents' };
  if (!draft) return { message: 'Loading your team…' };
  if (!adaptersEnabled) return { message: 'Finish the one-time setup above' };
  if (!brief.trim()) return { message: 'Describe the outcome to start' };
  if (!hasValidMembers(draft, members, all, readers)) return { message: 'Choose an available agent for every role', section: 'team' };
  if (draft.mode === 'duel' && !hasDistinctDuelSides(draft)) return { message: 'Make the two writers differ', section: 'team' };
  if (invalidLimits(draft).length > 0) return { message: 'Check the guardrail limits', section: 'guardrails' };
  return undefined;
}

export function presentAgents(agents: Array<AgentName | undefined>): AgentName[] {
  return agents.filter((agent): agent is AgentName => Boolean(agent));
}

export function startRequest(draft: TeamLaunchDraft, brief: string, checkCommand: string, members: TeamMemberConfig[]): TeamStartRequest {
  const request: TeamStartRequest = {
    brief, checkCommand: checkCommand.trim() || undefined,
    limits: { maxDurationMs: Number(draft.maxMinutes) * MINUTE_MS, maxTokens: Number(draft.maxTokens) },
    maxFixRounds: Number(draft.maxFixRounds), members, mode: draft.mode, policy: draft.policy,
  };
  if (draft.mode === 'duel' && draft.writer && draft.secondWriter) request.duelSides = [
    { agent: draft.writer, ...draft.writerTuning }, { agent: draft.secondWriter, ...draft.secondWriterTuning },
  ];
  return request;
}

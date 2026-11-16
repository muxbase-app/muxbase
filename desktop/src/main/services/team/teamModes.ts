import { AGENT_IDS, agentHasCapability, type AgentName } from 'muxbase/core';
import type { TeamMode, TeamSettingsDefaults } from '../../../shared/team-settings.js';
import type { TeamMemberConfig, TeamRun, TeamStartRequest } from '../../../shared/team-types.js';
import { teamSettingsSchema } from './teamSettingsValidation.js';

export interface ResolvedTeamRequest extends TeamStartRequest {
  maxFixRounds: number;
  members: TeamMemberConfig[];
  mode: TeamMode;
  policy: TeamRun['policy'];
}

function independentReviewer(preferred: AgentName, writers: AgentName[], available?: AgentName[]): AgentName {
  if (!agentHasCapability(preferred, 'review')) throw new Error(`${preferred} does not support read-only review`);
  if (!writers.includes(preferred)) {
    if (available && !available.includes(preferred)) throw new Error(`The selected reviewer ${preferred} is unavailable. Install it or explicitly choose another independent reviewer.`);
    return preferred;
  }
  const eligible = (agent: AgentName) => agentHasCapability(agent, 'review') && !writers.includes(agent) && (!available || available.includes(agent));
  const reviewer = [preferred, ...AGENT_IDS].find(eligible);
  if (!reviewer) throw new Error('No available independent provider supports read-only review. Install or choose an independent reviewer.');
  return reviewer;
}

function defaultMembers(mode: TeamMode, defaults: TeamSettingsDefaults, request: TeamStartRequest, available?: AgentName[]): TeamMemberConfig[] {
  const writer = request.members?.find((member) => member.role === 'developer')?.agent ?? defaults.teamWriterAgent;
  const writers = mode === 'duel' ? (request.duelSides?.map((side) => side.agent) ?? [writer, defaults.teamReviewerAgent]) : [writer];
  const reviewer = independentReviewer(defaults.teamReviewerAgent, mode === 'pair' ? writers : [], available);
  if (mode === 'duel') return [{ agent: writers[0], role: 'developer' }, { agent: writers[1], role: 'architect' }, { agent: reviewer, role: 'tester' }];
  if (mode === 'pair') return [{ agent: writer, role: 'developer' }, { agent: reviewer, role: 'tester' }];
  return [{ agent: writer, role: 'developer' }, ...defaults.teamCouncilRoles.map((role) => ({ agent: reviewer, role }))];
}

function validateMembers(request: ResolvedTeamRequest, available?: AgentName[]): void {
  if (request.mode === 'council') return;
  const writers = request.members.filter((member) => isTeamWriter(request.mode, member.role));
  const readers = request.members.filter((member) => !isTeamWriter(request.mode, member.role));
  if (request.mode === 'pair' && (writers.length !== 1 || readers.length !== 1 || request.members.length !== 2)) throw new Error('Pair needs exactly one writer and one independent reviewer');
  if (request.mode === 'duel' && (writers.length !== 2 || !readers.length || !writers.some((member) => member.role === 'architect'))) throw new Error('Duel needs Candidate A and Candidate B plus a separate read-only comparator');
  for (const reader of readers) {
    reader.agent = independentReviewer(reader.agent, request.mode === 'pair' ? writers.map((writer) => writer.agent) : [], available);
  }
}

export function resolveTeamRequest(request: TeamStartRequest, defaults: TeamSettingsDefaults, available?: AgentName[]): ResolvedTeamRequest {
  teamSettingsSchema.parse(defaults);
  const mode = request.mode ?? defaults.teamDefaultMode;
  const maxFixRounds = request.maxFixRounds ?? defaults.teamMaxFixRounds;
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 1 || maxFixRounds > 5) throw new Error('Maximum fix rounds must be an integer from 1 to 5');
  const duelSides = mode === 'duel' ? request.duelSides ?? [{ agent: defaults.teamWriterAgent }, { agent: defaults.teamReviewerAgent }] : undefined;
  if (duelSides && duelSides.map((side) => `${side.agent}|${side.model ?? ''}|${side.effort ?? ''}`).every((identity, _, identities) => identity === identities[0])) throw new Error('Duel sides must differ in agent, model, or effort');
  const resolved: ResolvedTeamRequest = {
    ...request,
    duelSides,
    limits: request.limits ?? { maxDurationMs: defaults.teamTimeLimitMinutes * 60_000, maxTokens: defaults.teamTokenBudget },
    maxFixRounds,
    members: request.members?.map((member) => ({ ...member })) ?? defaultMembers(mode, defaults, { ...request, duelSides }, available),
    mode,
    policy: request.policy ?? defaults.teamPolicy,
  };
  if (mode === 'duel') {
    for (const [index, role] of (['developer', 'architect'] as const).entries()) {
      const writer = resolved.members.find((member) => member.role === role);
      if (writer && duelSides) {
        writer.agent = duelSides[index].agent;
        writer.effort = duelSides[index].effort;
        writer.model = duelSides[index].model;
      }
    }
  }
  validateMembers(resolved, available);
  return resolved;
}

export function isTeamWriter(mode: TeamRun['mode'], role: TeamMemberConfig['role']): boolean {
  return role === 'developer' || (mode === 'duel' && role === 'architect');
}

export function teamBuildParticipants(run: TeamRun): TeamMemberConfig['role'][] {
  return run.members.filter((member) => !member.readOnly && (!run.selectedSourceId || member.paneId === run.selectedSourceId)).map((member) => member.role);
}

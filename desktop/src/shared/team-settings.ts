import type { AgentName } from 'muxbase/core';
import {
  TEAM_DEFAULT_DURATION_MS,
  TEAM_DEFAULT_TOKEN_BUDGET,
  type TeamPolicy,
} from './team-types.js';

export const TEAM_MODES = ['pair', 'duel', 'council'] as const;
export const TEAM_COUNCIL_ROLE_IDS = ['architect', 'tester', 'domain'] as const;

export type TeamMode = (typeof TEAM_MODES)[number];
export type TeamCouncilRoleId = (typeof TEAM_COUNCIL_ROLE_IDS)[number];

export interface TeamSettingsDefaults {
  teamCouncilRoles: TeamCouncilRoleId[];
  teamDefaultMode: TeamMode;
  teamMaxFixRounds: number;
  teamPolicy: TeamPolicy;
  teamReviewerAgent: AgentName;
  teamTimeLimitMinutes: number;
  teamTokenBudget: number;
  teamWriterAgent: AgentName;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettingsDefaults = {
  teamCouncilRoles: ['architect', 'tester'],
  teamDefaultMode: 'pair',
  teamMaxFixRounds: 2,
  teamPolicy: 'when-stuck',
  teamReviewerAgent: 'claude',
  teamTimeLimitMinutes: TEAM_DEFAULT_DURATION_MS / 60_000,
  teamTokenBudget: TEAM_DEFAULT_TOKEN_BUDGET,
  teamWriterAgent: 'codex',
};

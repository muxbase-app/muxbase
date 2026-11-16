import { AGENT_IDS, agentHasCapability } from 'muxbase/core';
import { z } from 'zod';
import { TEAM_COUNCIL_ROLE_IDS, TEAM_MODES } from '../../../shared/team-settings.js';

export const teamSettingsSchema = z.object({
  teamCouncilRoles: z.array(z.enum(TEAM_COUNCIL_ROLE_IDS)).min(1).max(TEAM_COUNCIL_ROLE_IDS.length)
    .refine((roles) => new Set(roles).size === roles.length, 'Council roles must be unique'),
  teamDefaultMode: z.enum(TEAM_MODES),
  teamMaxFixRounds: z.number().int().min(1).max(5),
  teamPolicy: z.enum(['every-gate', 'when-stuck']),
  teamReviewerAgent: z.enum(AGENT_IDS).refine(
    (agent) => agentHasCapability(agent, 'review'),
    'Choose an agent that supports read-only review',
  ),
  teamTimeLimitMinutes: z.number().int().min(1).max(1440),
  teamTokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  teamWriterAgent: z.enum(AGENT_IDS),
}).passthrough();

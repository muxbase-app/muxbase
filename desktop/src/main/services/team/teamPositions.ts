import { z } from 'zod';
import { TEAM_ROLE_IDS, type TeamPosition, type TeamRoundKind } from '../../../shared/team-types.js';

const POSITION_BLOCK = /```team-position[^\n]*\n([\s\S]*?)```/g;
const shortText = z.string().trim().min(1).max(600);
const longText = z.string().trim().min(1).max(4000);
const evidence = z.array(z.string().trim().min(1).max(300)).max(12).default([]);
const roleSchema = z.enum(TEAM_ROLE_IDS);

export const teamPositionSchema = z.object({
  acceptable: z.array(roleSchema).max(TEAM_ROLE_IDS.length).default([]),
  evidence,
  needsHuman: shortText.nullish().transform((value) => value ?? undefined),
  objections: z.array(z.object({
    claim: longText,
    evidence,
    severity: z.enum(['blocking', 'minor']).default('blocking'),
  }).refine((objection) => objection.severity !== 'blocking' || objection.evidence.length > 0)).max(12).default([]),
  proposal: z.object({
    cost: shortText,
    gain: shortText,
    risk: shortText,
    summary: longText,
    title: z.string().trim().min(1).max(80),
  }).nullish().transform((value) => value ?? undefined),
  responses: z.array(z.object({
    evidence,
    kind: z.enum(['concede', 'rebut']),
    text: longText,
    to: roleSchema,
  })).max(12).default([]),
  summary: longText,
  supports: roleSchema.nullish().transform((value) => value ?? undefined),
  verdict: z.enum(['approve', 'block']).nullish().transform((value) => value ?? undefined),
});

const positionReplySchema = teamPositionSchema.extend({ round: z.string() });

function meetsStageContract(position: TeamPosition, kind?: TeamRoundKind, firstDesignRound = false): boolean {
  if (position.needsHuman) return true;
  if (kind === 'review') return position.verdict !== undefined;
  if (kind !== 'design') return true;
  if (firstDesignRound) return position.proposal !== undefined;
  return position.proposal !== undefined || position.supports !== undefined || position.acceptable.length > 0;
}

export function parseTeamPosition(
  text: string,
  roundId: string,
  kind?: TeamRoundKind,
  firstDesignRound = false,
): TeamPosition | null {
  const blocks = [...text.matchAll(POSITION_BLOCK)];
  const body = blocks.at(-1)?.[1];
  if (!body) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = positionReplySchema.safeParse(raw);
  if (!parsed.success || parsed.data.round !== roundId) return null;
  const { round: _round, ...position } = parsed.data;
  return meetsStageContract(position, kind, firstDesignRound) ? position : null;
}

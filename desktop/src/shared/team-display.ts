import type { TeamMode } from './team-settings.js';
import type { TeamRoleId } from './team-types.js';

const DUEL_ROLES: Record<TeamRoleId, string> = {
  architect: 'Writer B',
  developer: 'Writer A',
  domain: 'Domain expert',
  tester: 'Comparator',
};

export function teamRoleDisplayName(mode: TeamMode | undefined, role: TeamRoleId, fallback: string): string {
  if (mode === 'duel') return DUEL_ROLES[role];
  if (mode === 'pair' && role === 'developer') return 'Writer';
  if (mode === 'pair' && role === 'tester') return 'Reviewer';
  return fallback;
}

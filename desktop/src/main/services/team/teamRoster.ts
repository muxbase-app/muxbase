import { agentHasCapability, getProjectMetadataDir } from 'muxbase/core';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import type { TeamMemberConfig, TeamRoleId, TeamStartRequest } from '../../../shared/team-types.js';
import { isTeamWriter } from './teamModes.js';

const ROLE_LABELS: Record<TeamRoleId, string> = {
  architect: 'Architect',
  developer: 'Developer',
  domain: 'Domain expert',
  tester: 'Tester',
};

const TITLE_MAX_CHARS = 64;

export function roleLabel(config: TeamMemberConfig): string {
  return config.role === 'domain' && config.domain?.trim() ? `${config.domain.trim()} expert` : ROLE_LABELS[config.role];
}

export function runTitle(brief: string): string {
  const firstSentence = brief.split(/\.\s|\n/)[0].replace(/\.$/, '').trim();
  return firstSentence.length > TITLE_MAX_CHARS ? `${firstSentence.slice(0, TITLE_MAX_CHARS - 1)}…` : firstSentence;
}

export function validateRoster(request: TeamStartRequest): string | null {
  if (!request.brief.trim()) return 'Describe what the team should build';
  const members = request.members ?? [];
  const roles = members.map((member) => member.role);
  if (new Set(roles).size !== roles.length) return 'Each role can only appear once';
  if (!roles.includes('developer')) return 'The team needs a Developer';
  if (roles.length < 2) return 'The team needs at least one reviewer';
  const reader = members.find((member) => !isTeamWriter(request.mode, member.role) && !agentHasCapability(member.agent, 'review'));
  return reader ? `${reader.agent} cannot run read-only, so it can only be the Developer` : null;
}

export function excludeMetadataFromGit(projectRoot: string, commonDir: string): void {
  const entry = `${basename(getProjectMetadataDir(projectRoot))}/`;
  const excludeFile = join(resolve(projectRoot, commonDir), 'info', 'exclude');
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
  if (!current.split('\n').includes(entry)) appendFileSync(excludeFile, `\n${entry}\n`);
}

import { getProjectMetadataDir, type MuxBasePane } from 'muxbase/core';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { teamRoleDisplayName } from '../../../shared/team-display.js';
import type { TeamMember, TeamMemberConfig, TeamRun } from '../../../shared/team-types.js';
import { gitOrThrow } from '../git/gitDiff.js';
import type { TeamLedger } from './TeamLedger.js';
import { isTeamWriter } from './teamModes.js';
import { roleLabel } from './teamRoster.js';
import type { TeamWorkflowDependencies } from './teamWorkflowTypes.js';

export function teamSlotBase(run: Pick<TeamRun, 'id'>, role: TeamMemberConfig['role']): string {
  return `team-${role}-${run.id.slice(0, 6)}`;
}

function matchesSlot(run: TeamRun, pane: MuxBasePane, config: TeamMemberConfig): boolean {
  const suffix = run.mode === 'duel' && isTeamWriter(run.mode, config.role) ? `-${config.role === 'developer' ? 'a' : 'b'}` : '';
  const base = `${teamSlotBase(run, config.role)}${suffix}`;
  if (pane.slug === base) return true;
  if (!pane.slug.startsWith(`${base}-`)) return false;
  const collision = pane.slug.slice(base.length + 1);
  return /^\d+$/.test(collision) && Number(collision) >= 2;
}

export function teamSlotConfig(run: TeamRun, pane: MuxBasePane): TeamMemberConfig | undefined {
  return (run.plannedMembers ?? run.members).find((config) => matchesSlot(run, pane, config));
}

export function unregisteredTeamPanes(run: TeamRun, dependencies: TeamWorkflowDependencies): MuxBasePane[] {
  const registered = new Set(run.members.map((member) => member.paneId));
  return (dependencies.getPanes?.() ?? []).filter((pane) => pane.teamRunId === run.id && !registered.has(pane.id));
}

export function teamMemberDraft(run: TeamRun, config: TeamMemberConfig): TeamMember {
  const readOnly = !isTeamWriter(run.mode, config.role);
  const side = run.mode === 'duel' && !readOnly ? run.duelSides?.[config.role === 'developer' ? 0 : 1] : undefined;
  return {
    ...config,
    effort: config.effort ?? side?.effort,
    label: teamRoleDisplayName(run.mode, config.role, roleLabel(config)),
    model: config.model ?? side?.model,
    paneId: '',
    readOnly,
    worktreePath: '',
  };
}

async function verifySurvivor(run: TeamRun, config: TeamMemberConfig, pane: MuxBasePane, catalog: MuxBasePane[]): Promise<TeamMember> {
  const draft = teamMemberDraft(run, config);
  if (!pane.projectRoot || !pane.worktreePath || pane.agent !== config.agent || (pane.role === 'review') !== draft.readOnly) throw new Error(`The ${draft.label} survivor has inconsistent agent or read-only slot identity`);
  const project = realpathSync(run.projectRoot);
  if (realpathSync(pane.projectRoot) !== project) throw new Error(`The ${draft.label} survivor project identity changed`);
  const worktree = realpathSync(pane.worktreePath);
  if (worktree !== join(getProjectMetadataDir(project), 'worktrees', pane.slug)) throw new Error(`The ${draft.label} survivor worktree does not match its managed slot identity`);
  const shared = catalog.some((other) => other.id !== pane.id && other.worktreePath && resolve(other.worktreePath) === resolve(pane.worktreePath ?? ''));
  if (shared) throw new Error(`The ${draft.label} survivor worktree has ambiguous pane ownership`);
  const [projectCommon, sourceCommon, top] = await Promise.all([
    gitOrThrow(project, ['rev-parse', '--git-common-dir']),
    gitOrThrow(worktree, ['rev-parse', '--git-common-dir']),
    gitOrThrow(worktree, ['rev-parse', '--show-toplevel']),
  ]);
  if (realpathSync(resolve(project, projectCommon.trim())) !== realpathSync(resolve(worktree, sourceCommon.trim())) || realpathSync(top.trim()) !== worktree) throw new Error(`The ${draft.label} survivor Git repository does not match its project and worktree identity`);
  if (run.mode === 'duel' && !draft.readOnly && (pane.duel?.groupId !== run.id || pane.duel.role !== (config.role === 'developer' ? 'a' : 'b'))) throw new Error(`The ${draft.label} native Duel slot identity changed`);
  return { ...draft, effort: pane.effort ?? draft.effort, model: pane.model ?? draft.model, paneId: pane.id, worktreePath: pane.worktreePath };
}

export class TeamPaneOwnership {
  constructor(private readonly ledger: TeamLedger, private readonly dependencies: TeamWorkflowDependencies) {}

  async adopt(runId: string): Promise<void> {
    const run = this.ledger.get(runId);
    const catalog = this.dependencies.getPanes?.() ?? [];
    const entries = unregisteredTeamPanes(run, this.dependencies).map((pane) => {
      const config = teamSlotConfig(run, pane);
      if (!config) throw new Error(`A Team-owned survivor has no matching planned slot identity: ${pane.id}`);
      return { config, pane };
    });
    const roles = new Set(run.members.map((member) => member.role));
    for (const entry of entries) {
      if (roles.has(entry.config.role)) throw new Error(`Ambiguous Team-owned survivors claim the ${entry.config.role} slot; all panes are preserved`);
      roles.add(entry.config.role);
    }
    const members: TeamMember[] = [];
    for (const entry of entries) members.push(await verifySurvivor(run, entry.config, entry.pane, catalog));
    if (!members.length) return;
    this.ledger.transaction(runId, () => {
      for (const member of members) this.ledger.commit(runId, { member, type: 'member' });
    });
  }
}

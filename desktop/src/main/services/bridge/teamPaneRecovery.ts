import { realpathSync } from 'fs';
import type { MuxBasePane } from 'muxbase/core';
import { basename, resolve } from 'path';
import type { TeamMember, TeamRun } from '../../../shared/team-types.js';

export interface TeamPaneBinding {
  cwd: string;
  logicalPaneId: string;
  paneId: string;
}

interface RecoveryDependencies {
  listBindings(): Promise<TeamPaneBinding[]>;
  recreatePane(pane: MuxBasePane): Promise<MuxBasePane | null>;
}

export async function resolveTeamRecoveryPane(
  existingPane: MuxBasePane | undefined,
  member: TeamMember,
  run: Pick<TeamRun, 'brief' | 'id' | 'projectRoot'>,
  dependencies: RecoveryDependencies,
): Promise<{ created: boolean; pane: MuxBasePane }> {
  const worktreePath = realpathSync(member.worktreePath);
  if (existingPane?.worktreePath && realpathSync(existingPane.worktreePath) !== worktreePath) {
    throw new Error('The team pane no longer owns its original worktree');
  }
  const template: MuxBasePane = {
    ...existingPane,
    agent: member.agent,
    effort: member.effort ?? existingPane?.effort,
    id: member.paneId,
    model: member.model ?? existingPane?.model,
    paneId: existingPane?.paneId ?? '',
    projectRoot: run.projectRoot,
    prompt: existingPane?.prompt ?? run.brief,
    role: member.readOnly ? 'review' : undefined,
    slug: existingPane?.slug ?? basename(member.worktreePath),
    teamRunId: run.id,
    worktreePath: member.worktreePath,
  };
  const bindings = (await dependencies.listBindings()).map((binding) => ({
    ...binding,
    cwd: realpathSync(binding.cwd),
  }));
  const owned = bindings.filter((binding) => binding.logicalPaneId === member.paneId);
  if (owned.length > 1) throw new Error('More than one tmux pane claims this team member');
  const occupied = bindings.some((binding) => (
    binding.logicalPaneId !== member.paneId && binding.cwd
    && (
      resolve(binding.cwd) === worktreePath
      || resolve(binding.cwd).startsWith(`${worktreePath}/`)
    )
  ));
  if (occupied) throw new Error('Another tmux pane is using the team worktree; refusing duplicate workers');
  if (owned[0]) return { created: false, pane: { ...template, paneId: owned[0].paneId } };
  if (bindings.some((binding) => binding.paneId === template.paneId)) {
    throw new Error('The original tmux pane has lost its team ownership marker');
  }
  const recreated = await dependencies.recreatePane(template);
  if (!recreated) throw new Error('The preserved team worktree is unavailable');
  return { created: true, pane: { ...recreated, teamRunId: run.id } };
}

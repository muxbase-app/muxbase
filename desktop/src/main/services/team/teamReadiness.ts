import type { PaneActivity } from '../../../shared/pane-activity.js';
import { isReadyForMutation } from '../../../shared/pane-activity.js';
import type { TeamMember } from '../../../shared/team-types.js';
import type { TeamPaneAccess } from './TeamRoundPoller.js';

export function captureTeamReadiness(panes: TeamPaneAccess, member: TeamMember): PaneActivity {
  const pane = panes.getPane(member.paneId);
  const activity = panes.getPaneActivity(member.paneId);
  const session = panes.getSession(member.paneId);
  if (!pane || pane.worktreePath !== member.worktreePath || !activity || !isReadyForMutation(activity) || session?.isOngoing || session?.awaitingUserInput) {
    throw new Error(`The ${member.label} is not confirmed ready for mutation`);
  }
  return { ...activity, openBackgroundWork: [...activity.openBackgroundWork] };
}

export function isTeamMemberReady(panes: TeamPaneAccess, member: TeamMember): boolean {
  const pane = panes.getPane(member.paneId);
  const activity = panes.getPaneActivity(member.paneId);
  if (!pane || pane.worktreePath !== member.worktreePath) throw new Error(`The ${member.label} registered pane or worktree is missing`);
  if (activity?.liveness === 'stopped' && activity.certainty === 'confirmed') throw new Error(`The ${member.label} stopped; explicit recovery is required`);
  const session = panes.getSession(member.paneId);
  return !!activity && isReadyForMutation(activity) && !session?.isOngoing && !session?.awaitingUserInput;
}

export function revalidateTeamReadiness(panes: TeamPaneAccess, member: TeamMember, before: PaneActivity): void {
  const current = captureTeamReadiness(panes, member);
  if (current.paneIncarnationId !== before.paneIncarnationId || current.activityRevision !== before.activityRevision) {
    throw new Error(`The ${member.label} activity or pane incarnation changed during this operation`);
  }
}

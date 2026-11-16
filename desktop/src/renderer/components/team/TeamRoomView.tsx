import { Fragment, useEffect, useMemo } from 'react';
import { useNotificationStore, useUiStore } from '../../stores';
import { isTeamToastVisible, useTeamStore } from '../../stores/team.store';
import { ModalSurface } from '../shared/ModalSurface';
import { TeamChannel } from './TeamChannel';
import { TeamLaunchForm } from './TeamLaunchForm';
import { TeamRunHeader } from './TeamRunHeader';
import './team.css';
import './team-feed.css';
import './team-dock.css';

export function TeamRoomView() {
  const runs = useTeamStore((s) => s.runs);
  const activeRunId = useTeamStore((s) => s.activeRunId);
  const launchOpen = useTeamStore((s) => s.launchOpen);
  const setLaunchOpen = useTeamStore((s) => s.setLaunchOpen);
  const run = useMemo(() => runs.find((candidate) => candidate.id === activeRunId), [activeRunId, runs]);
  const toasts = useNotificationStore((s) => s.toasts);
  const removeToast = useNotificationStore((s) => s.removeToast);

  useEffect(() => {
    if (!run || launchOpen) return;
    const ui = useUiStore.getState();
    for (const toast of toasts) {
      if (isTeamToastVisible(toast, ui.activeView, ui.viewMode)) removeToast(toast.id);
    }
  }, [launchOpen, removeToast, run, toasts]);

  if (!run) {
    return <div className="team-room team-room-empty" data-testid="team-room"><TeamLaunchForm /></div>;
  }

  return (
    <div className="team-room" data-testid="team-room">
      <Fragment key={run.id}>
        <TeamRunHeader run={run} />
        <TeamChannel run={run} />
      </Fragment>
      <ModalSurface label="New team run" onClose={() => setLaunchOpen(false)} open={launchOpen} panelClassName="team-launch-panel">
        <TeamLaunchForm onStarted={() => setLaunchOpen(false)} />
      </ModalSurface>
    </div>
  );
}

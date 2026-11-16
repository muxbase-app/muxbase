import { type ReactNode, useRef, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { finishTeamRun } from '../../api/team.api';
import { useNotificationStore } from '../../stores';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { canStopRun } from './teamViewModel';

interface StopRun {
  canStop: boolean;
  dialog: ReactNode;
  label: string;
  requestStop: () => void;
  stopping: boolean;
}

export function useStopRun(run: TeamRun): StopRun {
  const addToast = useNotificationStore((s) => s.addToast);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const canStop = canStopRun(run);
  const label = run.status === 'stopping' ? 'Try stopping again' : 'Stop run';

  const stop = async () => {
    if (stoppingRef.current || !canStop) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const response = await finishTeamRun({ outcome: 'stopped', runId: run.id });
      if (response.success) setConfirming(false);
      else addToast(response.error ?? 'Could not stop the team run', 'error');
    } catch (error) {
      addToast(`Could not stop the team run: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const dialog = (
    <ConfirmDialog
      confirmLabel={label}
      message="Agents and checks stop; reviewer panes close. All writer worktrees stay, including work started during design."
      onCancel={() => setConfirming(false)}
      onConfirm={() => void stop()}
      open={confirming}
      pending={stopping}
      title="Stop this team run?"
    />
  );
  return { canStop, dialog, label, requestStop: () => setConfirming(true), stopping };
}

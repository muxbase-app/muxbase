import { ChevronRight, FolderOpen, GitMerge, Plus, Square, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { revealPath } from '../../api/system.api';
import { finishTeamRun } from '../../api/team.api';
import { useNotificationStore, usePaneStore } from '../../stores';
import { useTeamStore } from '../../stores/team.store';
import { TeamCopyButton } from './TeamCopyButton';
import { canRetryPublication, memberFor, recoveryCopy } from './teamViewModel';
import { useStopRun } from './useStopRun';

function writerWorktree(run: TeamRun): string | undefined {
  const source = run.members.find((member) => member.paneId === run.selectedSourceId) ?? memberFor(run, 'developer');
  return source?.worktreePath;
}

function useRetryPublication(run: TeamRun) {
  const addToast = useNotificationStore((s) => s.addToast);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);

  const retry = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      const response = await finishTeamRun({ outcome: 'merged', runId: run.id });
      if (!response.success) addToast(response.error ?? 'Publishing still could not finish', 'error');
    } catch (error) {
      addToast(`Publishing still could not finish: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };
  return { retry, retrying };
}

function PublicationActions({ run }: Readonly<{ run: TeamRun }>) {
  const { retry, retrying } = useRetryPublication(run);
  const sourceReady = usePaneStore((s) => s.panes.some((pane) => pane.id === run.mergeIntent?.sourcePaneId));
  return (
    <>
      {sourceReady
        ? <button className="team-primary" disabled={retrying} onClick={() => void retry()} type="button"><GitMerge aria-hidden="true" />{retrying ? 'Retrying…' : 'Retry publishing'}</button>
        : <p className="team-recovery-note">The writer pane that holds this change is not open, so publishing cannot be retried here. Finish the merge by hand.</p>}
      <button className="team-ghost" onClick={() => void revealPath(run.projectRoot)} type="button"><FolderOpen aria-hidden="true" />Open project folder</button>
    </>
  );
}

function RunActions({ run }: Readonly<{ run: TeamRun }>) {
  const setLaunchOpen = useTeamStore((s) => s.setLaunchOpen);
  const { canStop, dialog, label, requestStop, stopping } = useStopRun(run);
  const worktree = writerWorktree(run);
  return (
    <>
      {worktree && (
        <button className="team-ghost" onClick={() => void revealPath(worktree)} type="button"><FolderOpen aria-hidden="true" />Open worktree</button>
      )}
      {canStop
        ? <button className="team-danger-ghost" disabled={stopping} onClick={requestStop} type="button"><Square aria-hidden="true" />{label}</button>
        : <button className="team-ghost" onClick={() => setLaunchOpen(true)} type="button"><Plus aria-hidden="true" />New run</button>}
      {dialog}
    </>
  );
}

export function TeamRecoveryCard({ error, run }: Readonly<{ error: string; run: TeamRun }>) {
  const titleId = useId();
  const [title, explanation] = recoveryCopy(run);
  return (
    <section aria-labelledby={titleId} className="team-recovery" data-testid="team-recovery">
      <div className="team-recovery-head">
        <span aria-hidden="true" className="team-recovery-icon"><TriangleAlert /></span>
        <div>
          <h3 id={titleId}>{title}</h3>
          <p>{explanation}</p>
        </div>
      </div>
      <details className="team-recovery-details">
        <summary><ChevronRight aria-hidden="true" className="team-chevron" />Details</summary>
        <div className="team-out">
          <pre aria-label="Error details" role="region" tabIndex={0}>{error}</pre>
          <TeamCopyButton label="Copy error details" text={error} />
        </div>
      </details>
      <div className="team-recovery-actions">
        {canRetryPublication(run) ? <PublicationActions run={run} /> : <RunActions run={run} />}
      </div>
    </section>
  );
}

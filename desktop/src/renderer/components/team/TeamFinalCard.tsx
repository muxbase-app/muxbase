import { GitMerge, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { prepareTeamMerge } from '../../api/team.api';
import { usePaneActions } from '../../hooks/usePaneActions';
import { useNotificationStore, usePaneStore } from '../../stores';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import type { CheckItem } from './teamFeedModel';
import { TeamDiffDialog } from './TeamDiffDialog';
import { memberFor, runStats } from './teamViewModel';

function latestCheckPassed(run: TeamRun): boolean | undefined {
  return run.feed.filter((item): item is CheckItem => item.kind === 'check').at(-1)?.passed;
}

function finalFacts(run: TeamRun, checksPassed: boolean | undefined, filesChanged: number): string[] {
  return [
    filesChanged > 0 ? `${filesChanged} ${filesChanged === 1 ? 'file' : 'files'} changed` : '',
    checksPassed === undefined ? '' : `checks ${checksPassed ? 'passed' : 'failed'}`,
    run.approval?.kind === 'review' ? 'review approved' : '',
    ...runStats(run),
  ].filter(Boolean);
}

function useMerge(run: TeamRun) {
  const addToast = useNotificationStore((s) => s.addToast);
  const { mergePane } = usePaneActions();
  const [merging, setMerging] = useState(false);
  const mergingRef = useRef(false);

  const merge = async () => {
    if (mergingRef.current || run.status !== 'ready') return;
    mergingRef.current = true;
    setMerging(true);
    try {
      const prepared = await prepareTeamMerge({ runId: run.id });
      if (!prepared.success || !prepared.paneId) {
        addToast(prepared.error ?? 'This run cannot merge yet', 'error');
        return;
      }
      if (run.mode === 'duel' && prepared.paneId !== run.selectedSourceId) {
        addToast('The selected writer changed. Wait for the updated run before merging.', 'error');
        return;
      }
      await mergePane(prepared.paneId);
    } catch (error) {
      addToast(`Could not merge the team run: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      mergingRef.current = false;
      setMerging(false);
    }
  };
  return { merge, merging };
}

function barTitle(run: TeamRun, waivedFailure: boolean): string {
  if (run.status === 'merged') return 'Merged';
  return waivedFailure ? 'Ready to merge with a waived check' : 'Ready to merge';
}

export function TeamFinalCard({ run }: Readonly<{ run: TeamRun }>) {
  const { merge, merging } = useMerge(run);
  const [diffOpen, setDiffOpen] = useState(false);
  const sourcePaneId = run.selectedSourceId ?? memberFor(run, 'developer')?.paneId;
  const sourcePane = usePaneStore((s) => s.panes.find((pane) => pane.id === sourcePaneId));
  const filesChanged = useWorktreeStatusStore((s) => (sourcePaneId ? s.statuses[sourcePaneId]?.filesChanged : undefined)) ?? 0;
  const ready = run.status === 'ready';
  const checksPassed = latestCheckPassed(run);
  const waived = run.approval?.kind === 'waiver';
  const waivedFailure = waived && checksPassed === false;
  const facts = finalFacts(run, checksPassed, filesChanged);

  return (
    <div className={`team-bar ${waivedFailure ? 'waived' : 'success'}`} data-testid="team-final">
      <span aria-hidden="true" className="team-bar-icon">{waivedFailure ? <TriangleAlert /> : <GitMerge />}</span>
      <div className="team-bar-text">
        <h2 className="team-bar-title">{barTitle(run, waivedFailure)}</h2>
        {facts.length > 0 && <p className="team-bar-ctx">{facts.join(' · ')}</p>}
        {waivedFailure && <p className="team-bar-ctx warn">Merging with failed checks (waived)</p>}
        {waived && <p className="team-bar-ctx"><b>Approval waived</b> <span>{run.approval?.reason}</span></p>}
        {ready && sourcePaneId && !sourcePane && <p className="team-bar-ctx" role="status">The writer pane is unavailable. Recover it before inspecting its changes.</p>}
      </div>
      {ready && (
        <div className="team-bar-actions">
          {sourcePaneId && (
            <button className="team-quiet" disabled={!sourcePane} onClick={() => setDiffOpen(true)} type="button">View changes</button>
          )}
          <button className={waivedFailure ? 'team-primary amber' : 'team-primary'} data-testid="team-merge" disabled={merging} onClick={() => void merge()} type="button">
            {merging ? 'Merging…' : 'Merge'}
          </button>
          <TeamDiffDialog
            description="Live writer diff. Source and target approval are rechecked before merge."
            onClose={() => setDiffOpen(false)}
            open={diffOpen}
            pane={sourcePane}
            title="Review writer changes"
          />
        </div>
      )}
    </div>
  );
}

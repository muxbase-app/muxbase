import { useEffect, useRef } from 'react';
import { IPC_EVENT } from '../../shared/ipc-channels';
import type { TeamRun } from '../../shared/team-types';
import { on } from '../api/ipc';
import { listTeamRuns } from '../api/team.api';
import { useNotificationStore, useProjectStore } from '../stores';
import { isNewerTeamRun, useTeamStore } from '../stores/team.store';

export function useTeamRuns(): void {
  const activeRoot = useProjectStore((s) => s.activeProject?.root);
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const store = useTeamStore.getState();
    store.setActiveProjectRoot(activeRoot ?? null);
    if (!activeRoot) return;

    let disposed = false;
    let pending = true;
    const buffered = new Map<string, TeamRun>();
    const isCurrent = () => !disposed
      && generation.current === requestGeneration
      && useProjectStore.getState().activeProject?.root === activeRoot
      && useTeamStore.getState().activeProjectRoot === activeRoot;
    const applyBuffered = () => {
      pending = false;
      for (const run of buffered.values()) store.upsertRun(run);
      buffered.clear();
    };
    const unsubscribe = on(IPC_EVENT.TEAM_RUN_CHANGED, (event) => {
      const run = event as TeamRun;
      if (!isCurrent() || run.projectRoot !== activeRoot) return;
      if (!pending) {
        store.upsertRun(run);
        return;
      }
      const previous = buffered.get(run.id);
      if (!previous || isNewerTeamRun(run, previous)) buffered.set(run.id, run);
    });

    void listTeamRuns().then((runs) => {
      if (!isCurrent()) return;
      store.setRuns(runs);
      applyBuffered();
    }).catch((error: unknown) => {
      if (!isCurrent()) return;
      applyBuffered();
      const message = error instanceof Error ? error.message : String(error);
      useNotificationStore.getState().addToast(`Could not load team runs: ${message}`, 'error');
    });

    return () => {
      disposed = true;
      buffered.clear();
      unsubscribe();
    };
  }, [activeRoot]);
}

import { create } from 'zustand';
import type { ToastEvent } from '../../shared/ipc-types';
import type { TeamRun } from '../../shared/team-types';

interface TeamState {
  activeProjectRoot: string | null | undefined;
  activeRunId: string | null;
  autoOpenedDecisionIds: string[];
  launchBriefs: Record<string, string>;
  launchOpen: boolean;
  markDecisionAutoOpened: (decisionId: string) => void;
  runs: TeamRun[];
  selectRun: (runId: string) => void;
  setActiveProjectRoot: (root: string | null) => void;
  setLaunchBrief: (projectRoot: string, brief: string) => void;
  setLaunchOpen: (open: boolean) => void;
  setRuns: (runs: TeamRun[]) => void;
  upsertRun: (run: TeamRun) => void;
}

function sortRuns(runs: TeamRun[]): TeamRun[] {
  return [...runs].sort((left, right) => right.createdAt - left.createdAt);
}

export function isNewerTeamRun(candidate: TeamRun, previous: TeamRun): boolean {
  if (candidate.revision !== undefined && previous.revision !== undefined) {
    return candidate.revision > previous.revision;
  }
  if (previous.revision !== undefined) return false;
  if (candidate.revision !== undefined) return true;
  return candidate.updatedAt > previous.updatedAt;
}

export const useTeamStore = create<TeamState>((set) => ({
  activeProjectRoot: undefined,
  activeRunId: null,
  autoOpenedDecisionIds: [],
  launchBriefs: {},
  launchOpen: false,
  markDecisionAutoOpened: (decisionId) => set((state) => (
    state.autoOpenedDecisionIds.includes(decisionId)
      ? state
      : { autoOpenedDecisionIds: [...state.autoOpenedDecisionIds, decisionId] }
  )),
  runs: [],
  selectRun: (activeRunId) => set({ activeRunId }),
  setActiveProjectRoot: (activeProjectRoot) => set((state) => (
    state.activeProjectRoot === activeProjectRoot
      ? state
      : { activeProjectRoot, activeRunId: null, launchOpen: false, runs: [] }
  )),
  setLaunchBrief: (projectRoot, brief) => set((state) => ({
    launchBriefs: { ...state.launchBriefs, [projectRoot]: brief },
  })),
  setLaunchOpen: (launchOpen) => set({ launchOpen }),
  setRuns: (runs) => set((state) => {
    const activeProjectRoot = state.activeProjectRoot === undefined ? runs[0]?.projectRoot : state.activeProjectRoot;
    if (runs.length > 0 && !runs.some((run) => run.projectRoot === activeProjectRoot)) return state;
    const current = new Map(state.runs.map((run) => [run.id, run]));
    const reconciled = new Map<string, TeamRun>();
    for (const run of runs) {
      if (run.projectRoot !== activeProjectRoot) continue;
      const previous = reconciled.get(run.id) ?? current.get(run.id);
      reconciled.set(run.id, previous && !isNewerTeamRun(run, previous) ? previous : run);
    }
    const sorted = sortRuns([...reconciled.values()]);
    const keepsActive = sorted.some((run) => run.id === state.activeRunId);
    return { activeProjectRoot, activeRunId: keepsActive ? state.activeRunId : sorted[0]?.id ?? null, runs: sorted };
  }),
  upsertRun: (run) => set((state) => {
    const activeProjectRoot = state.activeProjectRoot === undefined ? run.projectRoot : state.activeProjectRoot;
    if (run.projectRoot !== activeProjectRoot) return state;
    const previous = state.runs.find((candidate) => candidate.id === run.id);
    if (previous && !isNewerTeamRun(run, previous)) return state;
    return {
      activeProjectRoot,
      activeRunId: state.activeRunId ?? run.id,
      runs: sortRuns([...state.runs.filter((candidate) => candidate.id !== run.id), run]),
    };
  }),
}));

export function selectTeamRunFromNotice(identity: NonNullable<ToastEvent['teamReady']>): void {
  const state = useTeamStore.getState();
  if (state.activeProjectRoot !== identity.projectRoot) return;
  if (state.runs.some((run) => run.id === identity.runId)) state.selectRun(identity.runId);
  state.setLaunchOpen(false);
}

export function openDecisionCount(runs: TeamRun[]): number {
  return runs.filter((run) => run.status === 'waiting').length;
}

export function isTeamReadyVisible(ready: NonNullable<ToastEvent['teamReady']>, activeView: string, viewMode: string): boolean {
  return isTeamToastVisible({ severity: 'success', teamReady: ready }, activeView, viewMode);
}

type TeamToast = Pick<ToastEvent, 'severity' | 'teamReady'> & Partial<Pick<ToastEvent, 'message'>>;

function isActiveRunError(state: TeamState, message: string | undefined): boolean {
  const run = state.runs.find((candidate) => candidate.id === state.activeRunId);
  return Boolean(message && run?.error === message);
}

export function isTeamToastVisible(toast: TeamToast, activeView: string, viewMode: string): boolean {
  const state = useTeamStore.getState();
  if (activeView !== 'dashboard' || viewMode !== 'team' || state.launchOpen) return false;
  if (isActiveRunError(state, toast.message)) return true;
  const identity = toast.teamReady;
  if (!identity) return false;
  if (identity.projectRoot !== state.activeProjectRoot || identity.runId !== state.activeRunId) return false;
  const run = state.runs.find((candidate) => candidate.id === identity.runId);
  if (toast.severity === 'success') return run?.status === 'ready';
  return toast.severity === 'warning' && run?.status === 'waiting' && run.decisions.some((decision) => !decision.chosen);
}

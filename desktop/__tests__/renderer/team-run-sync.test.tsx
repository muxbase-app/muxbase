// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamRuns } from '../../src/renderer/hooks/useTeamRuns';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import { useProjectStore } from '../../src/renderer/stores/project.store';
import { useTeamStore } from '../../src/renderer/stores/team.store';
import { IPC, IPC_EVENT } from '../../src/shared/ipc-channels';
import { deferred, teamRun } from './team-test-support';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipc.listeners.set(channel, listener);
    return () => ipc.listeners.delete(channel);
  }),
}));

vi.mock('../../src/renderer/api/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }));

function project(root: string) {
  return { configPath: '', name: root, paneCount: 0, root, sessionName: 'session' };
}

describe('Team run synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.listeners.clear();
    useTeamStore.setState({ activeRunId: null, runs: [] });
    useNotificationStore.getState().clearToasts();
    useProjectStore.getState().setActiveProject(project('/project/a'));
  });

  afterEach(cleanup);

  it('subscribes before fetching and retains a newer pushed revision after a delayed snapshot', async () => {
    const snapshot = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValue(snapshot.promise);
    renderHook(() => useTeamRuns());
    expect(ipc.on.mock.invocationCallOrder[0]).toBeLessThan(ipc.invoke.mock.invocationCallOrder[0]);
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.TEAM_LIST);

    act(() => ipc.listeners.get(IPC_EVENT.TEAM_RUN_CHANGED)?.(teamRun({ revision: 7, status: 'waiting', updatedAt: 10 })));
    await act(async () => snapshot.resolve([teamRun({ revision: 6, updatedAt: 10 })]));

    expect(useTeamStore.getState().runs[0]?.status).toBe('waiting');
    expect(useTeamStore.getState().runs[0]?.revision).toBe(7);
  });

  it('keeps a pushed run absent from the initial list', async () => {
    const snapshot = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValue(snapshot.promise);
    renderHook(() => useTeamRuns());

    act(() => ipc.listeners.get(IPC_EVENT.TEAM_RUN_CHANGED)?.(teamRun({ revision: 2 })));
    await act(async () => snapshot.resolve([]));

    expect(useTeamStore.getState().runs.map((run) => run.id)).toEqual(['run-a']);
  });

  it('ignores the late A snapshot and A events after switching to B', async () => {
    const first = deferred<ReturnType<typeof teamRun>[]>();
    const second = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderHook(() => useTeamRuns());

    act(() => useProjectStore.getState().setActiveProject(project('/project/b')));
    await act(async () => second.resolve([teamRun({ id: 'run-b', projectRoot: '/project/b' })]));
    act(() => ipc.listeners.get(IPC_EVENT.TEAM_RUN_CHANGED)?.(teamRun({ revision: 99 })));
    await act(async () => first.resolve([teamRun()]));

    expect(useTeamStore.getState().runs.map((run) => run.id)).toEqual(['run-b']);
  });

  it('ignores a superseded fetch when returning to the same project', async () => {
    const oldA = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValueOnce(oldA.promise).mockResolvedValueOnce([])
      .mockResolvedValueOnce([teamRun({ revision: 10, status: 'waiting' })]);
    renderHook(() => useTeamRuns());

    act(() => useProjectStore.getState().setActiveProject(project('/project/b')));
    act(() => useProjectStore.getState().setActiveProject(project('/project/a')));
    await act(async () => { await Promise.resolve(); });
    await act(async () => oldA.resolve([teamRun({ revision: 1 })]));

    expect(useTeamStore.getState().runs[0]?.revision).toBe(10);
  });

  it('clears the previous project immediately while the next snapshot is pending', async () => {
    ipc.invoke.mockResolvedValueOnce([teamRun()]).mockReturnValueOnce(deferred().promise);
    renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });

    act(() => useProjectStore.getState().setActiveProject(project('/project/b')));

    expect(useTeamStore.getState().runs).toEqual([]);
    expect(useTeamStore.getState().activeRunId).toBeNull();
  });

  it('keeps the persisted revision across a new subscription epoch', async () => {
    ipc.invoke.mockResolvedValueOnce([teamRun({ revision: 20, updatedAt: 100 })])
      .mockResolvedValueOnce([teamRun({ revision: 19, updatedAt: 200 })]);
    const first = renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });
    first.unmount();
    renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });

    expect(useTeamStore.getState().runs[0]?.revision).toBe(20);
  });

  it('surfaces a list rejection while preserving buffered push data', async () => {
    const snapshot = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValue(snapshot.promise);
    renderHook(() => useTeamRuns());
    act(() => ipc.listeners.get(IPC_EVENT.TEAM_RUN_CHANGED)?.(teamRun({ revision: 3 })));

    await act(async () => snapshot.reject(new Error('List unavailable')));

    expect(useTeamStore.getState().runs[0]?.revision).toBe(3);
    expect(useNotificationStore.getState().toasts.at(-1)).toMatchObject({
      message: expect.stringContaining('List unavailable'), severity: 'error',
    });
  });

  it('rejects older same-run replacements with equal timestamps', async () => {
    ipc.invoke.mockResolvedValue([teamRun({ revision: 8, updatedAt: 30 })]);
    renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });

    act(() => {
      useTeamStore.getState().upsertRun(teamRun({ revision: 7, updatedAt: 30 }));
      useTeamStore.getState().setRuns([teamRun({ revision: 6, updatedAt: 30 })]);
    });

    expect(useTeamStore.getState().runs[0]?.revision).toBe(8);
  });

  it('uses updatedAt for legacy runs and rejects foreign direct store updates', async () => {
    ipc.invoke.mockResolvedValue([teamRun({ updatedAt: 30 })]);
    renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });

    act(() => {
      useTeamStore.getState().upsertRun(teamRun({ updatedAt: 20 }));
      useTeamStore.getState().upsertRun(teamRun({ id: 'foreign', projectRoot: '/project/b' }));
    });

    expect(useTeamStore.getState().runs).toEqual([teamRun({ updatedAt: 30 })]);
  });

  it('does not discard this project when a list responds with only foreign runs', async () => {
    ipc.invoke.mockResolvedValueOnce([teamRun({ revision: 4 })])
      .mockResolvedValueOnce([teamRun({ id: 'foreign', projectRoot: '/project/b' })]);
    const first = renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });
    first.unmount();
    renderHook(() => useTeamRuns());
    await act(async () => { await Promise.resolve(); });

    expect(useTeamStore.getState().runs.map((run) => run.id)).toEqual(['run-a']);
  });

  it('does not accept late list, event, or direct updates after clearing the active project', async () => {
    const snapshot = deferred<ReturnType<typeof teamRun>[]>();
    ipc.invoke.mockReturnValue(snapshot.promise);
    renderHook(() => useTeamRuns());
    const listener = ipc.listeners.get(IPC_EVENT.TEAM_RUN_CHANGED);
    act(() => useProjectStore.getState().setActiveProject(null));
    act(() => {
      listener?.(teamRun({ revision: 8 }));
      useTeamStore.getState().upsertRun(teamRun({ revision: 8 }));
      useTeamStore.getState().setRuns([teamRun({ revision: 8 })]);
    });
    await act(async () => snapshot.resolve([teamRun()]));

    expect(useTeamStore.getState().runs).toEqual([]);
  });
});

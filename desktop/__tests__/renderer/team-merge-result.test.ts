// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneActions } from '../../src/renderer/hooks/usePaneActions';
import { useNotificationStore } from '../../src/renderer/stores/notification.store';
import { IPC } from '../../src/shared/ipc-channels';
import type { SerializableActionResult } from '../../src/shared/ipc-types';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../../src/renderer/api/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }));

describe('mergePane result contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.getState().clearToasts();
  });
  afterEach(cleanup);

  it('returns the actual resolved success after merge callbacks', async () => {
    const success: SerializableActionResult = { message: 'Merged into main', type: 'success' };
    ipc.invoke.mockResolvedValueOnce({ callbackId: 'confirm', message: 'Merge?', title: 'Merge Worktree', type: 'confirm' })
      .mockResolvedValueOnce(success);
    const { result } = renderHook(() => usePaneActions());

    const merged = await result.current.mergePane('developer');

    expect(merged).toEqual(success);
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.ACTION_CALLBACK, { callbackId: 'confirm' });
  });

  it.each<SerializableActionResult>([
    { message: 'Unresolved conflicts', title: 'Merge Conflicts Detected', type: 'choice' },
    { message: 'Commit the target first', title: 'Choose a strategy', type: 'choice' },
    { message: 'Merge rejected', type: 'error' },
    { message: 'Cancelled', type: 'info' },
  ])('returns unresolved or rejected $type results to its caller', async (action) => {
    ipc.invoke.mockResolvedValue(action);
    const { result } = renderHook(() => usePaneActions());

    expect(await result.current.mergePane('developer')).toEqual(action);
  });

  it('converts an IPC rejection into a returned error and visible toast', async () => {
    ipc.invoke.mockRejectedValue(new Error('Git unavailable'));
    const { result } = renderHook(() => usePaneActions());

    expect(await result.current.mergePane('developer')).toEqual({ message: 'Git unavailable', type: 'error' });
    expect(useNotificationStore.getState().toasts.at(-1)?.severity).toBe('error');
  });

  it('returns a visible error even for a non-Error IPC rejection', async () => {
    ipc.invoke.mockRejectedValue('Git unavailable');
    const { result } = renderHook(() => usePaneActions());

    expect(await result.current.mergePane('developer')).toEqual({ message: 'Git unavailable', type: 'error' });
    expect(useNotificationStore.getState().toasts.at(-1)?.severity).toBe('error');
  });
});

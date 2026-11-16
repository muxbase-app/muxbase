// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import { TeamSettings } from '../../src/renderer/components/settings/TeamSettings';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import { IPC } from '../../src/shared/ipc-channels';
import type { ElectronSettingsUpdateRequest } from '../../src/shared/ipc-types';
import { deferred } from './team-test-support';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../../src/renderer/api/ipc', () => ({ invoke: ipc.invoke, on: ipc.on }));

describe('Team Settings preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useElectronSettingsStore.setState({ settings: ElectronSettingsService.getDefaults(), isLoading: false, loadError: null });
    ipc.invoke.mockImplementation(async (channel: string, request: ElectronSettingsUpdateRequest) => {
      if (channel === IPC.AGENT_LIST) return ['claude', 'codex'];
      return { ...useElectronSettingsStore.getState().settings, [request.key]: request.value };
    });
  });
  afterEach(cleanup);

  it('saves mode and selected Council roles while retaining newer optimistic edits', async () => {
    const pending = deferred<ReturnType<typeof ElectronSettingsService.getDefaults>>();
    render(<TeamSettings />);
    await act(async () => { await Promise.resolve(); });
    ipc.invoke.mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByRole('combobox', { name: 'Default mode' }), { target: { value: 'council' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Domain expert' }));
    expect((screen.getByRole('checkbox', { name: 'Domain expert' }) as HTMLInputElement).checked).toBe(true);
    pending.resolve({ ...ElectronSettingsService.getDefaults(), teamDefaultMode: 'council' });
    await act(async () => { await Promise.resolve(); });
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.ELECTRON_SETTINGS_UPDATE, { key: 'teamCouncilRoles', value: ['architect', 'tester', 'domain'] });
    expect(useElectronSettingsStore.getState().settings?.teamCouncilRoles).toEqual(['architect', 'tester', 'domain']);
    expect(useElectronSettingsStore.getState().settings?.teamDefaultMode).toBe('council');
  });

  it('keeps at least one Council reviewer selected and retains an unavailable preference', async () => {
    useElectronSettingsStore.setState({ settings: { ...ElectronSettingsService.getDefaults(), teamCouncilRoles: ['tester'], teamWriterAgent: 'pi' } });
    render(<TeamSettings />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('checkbox', { name: 'Tester' }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Writer agent' }) as HTMLSelectElement).value).toBe('pi');
    expect(screen.queryByText(/72.*90|cost.*times/i)).toBeNull();
  });
});

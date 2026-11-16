import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronSettingsService } from '../../src/main/services/ElectronSettingsService';
import { useElectronSettingsStore } from '../../src/renderer/stores/electron-settings.store';
import type { ElectronSettings } from '../../src/shared/ipc-types';
import { deferred } from '../renderer/team-test-support';

const api = vi.hoisted(() => ({ getElectronSettings: vi.fn(), resetElectronSettings: vi.fn(), updateElectronSetting: vi.fn() }));
vi.mock('../../src/renderer/api/electron-settings.api', () => api);

describe('Electron Settings concurrent edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useElectronSettingsStore.setState({ settings: null, isLoading: false, loadError: null });
  });

  it('coalesces initial loads and does not overwrite edits on repeated visits', async () => {
    const loaded = deferred<ElectronSettings>();
    api.getElectronSettings.mockReturnValue(loaded.promise);
    const first = useElectronSettingsStore.getState().load();
    const second = useElectronSettingsStore.getState().load();
    loaded.resolve(ElectronSettingsService.getDefaults());
    await Promise.all([first, second]);
    expect(api.getElectronSettings).toHaveBeenCalledTimes(1);
    api.updateElectronSetting.mockResolvedValue({ ...ElectronSettingsService.getDefaults(), teamDefaultMode: 'duel' });
    await useElectronSettingsStore.getState().update('teamDefaultMode', 'duel');
    await useElectronSettingsStore.getState().load();
    expect(useElectronSettingsStore.getState().settings?.teamDefaultMode).toBe('duel');
    expect(api.getElectronSettings).toHaveBeenCalledTimes(1);
  });

  it('retains later optimistic edits when an earlier response or rejection arrives', async () => {
    const defaults = ElectronSettingsService.getDefaults();
    useElectronSettingsStore.setState({ settings: defaults });
    const first = deferred<ElectronSettings>();
    const second = deferred<ElectronSettings>();
    api.updateElectronSetting.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const writer = useElectronSettingsStore.getState().update('teamWriterAgent', 'claude');
    const reviewer = useElectronSettingsStore.getState().update('teamReviewerAgent', 'codex');
    first.resolve({ ...defaults, teamWriterAgent: 'claude' });
    await writer;
    expect(useElectronSettingsStore.getState().settings?.teamReviewerAgent).toBe('codex');
    second.reject(new Error('Storage unavailable'));
    await reviewer;
    expect(useElectronSettingsStore.getState().settings?.teamWriterAgent).toBe('claude');
    expect(useElectronSettingsStore.getState().settings?.teamReviewerAgent).toBe('claude');
  });

  it('restores the accepted same-key value when the latest edit fails', async () => {
    const defaults = ElectronSettingsService.getDefaults();
    useElectronSettingsStore.setState({ settings: defaults });
    const first = deferred<ElectronSettings>();
    const second = deferred<ElectronSettings>();
    api.updateElectronSetting.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const duel = useElectronSettingsStore.getState().update('teamDefaultMode', 'duel');
    const council = useElectronSettingsStore.getState().update('teamDefaultMode', 'council');
    first.resolve({ ...defaults, teamDefaultMode: 'duel' });
    await duel;
    expect(useElectronSettingsStore.getState().settings?.teamDefaultMode).toBe('council');
    second.reject(new Error('Storage unavailable'));
    await council;
    expect(useElectronSettingsStore.getState().settings?.teamDefaultMode).toBe('duel');
  });

  it('clones role edits before display and queued persistence', async () => {
    const defaults = ElectronSettingsService.getDefaults();
    useElectronSettingsStore.setState({ settings: defaults });
    const saved = deferred<ElectronSettings>();
    api.updateElectronSetting.mockReturnValue(saved.promise);
    const roles: ElectronSettings['teamCouncilRoles'] = ['architect', 'tester'];
    const update = useElectronSettingsStore.getState().update('teamCouncilRoles', roles);
    roles.push('domain');
    expect(useElectronSettingsStore.getState().settings?.teamCouncilRoles).toEqual(['architect', 'tester']);
    saved.resolve(defaults);
    await update;
    expect(api.updateElectronSetting).toHaveBeenCalledWith({ key: 'teamCouncilRoles', value: ['architect', 'tester'] });
  });

  it('retains an edit queued after reset instead of overwriting it with the reset response', async () => {
    const defaults = ElectronSettingsService.getDefaults();
    useElectronSettingsStore.setState({ settings: { ...defaults, teamDefaultMode: 'duel' } });
    const resetting = deferred<ElectronSettings>();
    const saving = deferred<ElectronSettings>();
    api.resetElectronSettings.mockReturnValue(resetting.promise);
    api.updateElectronSetting.mockReturnValue(saving.promise);
    const reset = useElectronSettingsStore.getState().reset();
    const update = useElectronSettingsStore.getState().update('teamMaxFixRounds', 4);
    resetting.resolve(defaults);
    await reset;
    expect(useElectronSettingsStore.getState().settings).toMatchObject({ teamDefaultMode: 'pair', teamMaxFixRounds: 4 });
    saving.resolve({ ...defaults, teamMaxFixRounds: 4 });
    await update;
    expect(useElectronSettingsStore.getState().settings?.teamMaxFixRounds).toBe(4);
  });
});

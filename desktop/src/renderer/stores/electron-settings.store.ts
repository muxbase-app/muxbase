import { create } from 'zustand';
import type { ElectronSettings } from '../../shared/ipc-types';
import * as electronSettingsApi from '../api/electron-settings.api';
import { useNotificationStore } from './notification.store';
import { useUiStore } from './ui.store';

interface ElectronSettingsState {
  settings: ElectronSettings | null;
  isLoading: boolean;
  loadError: string | null;
}

interface ElectronSettingsActions {
  load: () => Promise<void>;
  update: <K extends keyof ElectronSettings>(key: K, value: ElectronSettings[K]) => Promise<void>;
  reset: () => Promise<void>;
}

function toastError(title: string, error: unknown): void {
  useNotificationStore.getState().addToast('Please try again.', 'error', {
    title,
    detail: error instanceof Error ? error.message : String(error),
  });
}

function applySettingsToUiStore(settings: ElectronSettings): void {
  const ui = useUiStore.getState();
  ui.setTheme(settings.theme);
  ui.setSidebarCollapsed(settings.sidebarCollapsed);
  ui.setSidebarOrganize(settings.sidebarOrganize);
  ui.setSidebarSort(settings.sidebarSort);
  ui.setSidebarWidth(settings.sidebarWidth);
}

export const useElectronSettingsStore = create<ElectronSettingsState & ElectronSettingsActions>((set, get) => {
  let loadPromise: Promise<void> | null = null;
  let queue = Promise.resolve();
  let confirmed: ElectronSettings | null = null;
  const pending = new Map<keyof ElectronSettings, { id: symbol; value: ElectronSettings[keyof ElectronSettings] }>();

  function displaySettings(settings: ElectronSettings): ElectronSettings {
    const result = { ...settings };
    for (const [key, edit] of pending) Object.assign(result, { [key]: edit.value });
    return result;
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }

  return {
    settings: null,
    isLoading: false,
    loadError: null,

    load: () => {
      if (get().settings) return Promise.resolve();
      if (loadPromise) return loadPromise;
      set({ isLoading: true, loadError: null });
      loadPromise = electronSettingsApi.getElectronSettings().then((settings) => {
        confirmed = settings;
        set({ settings: displaySettings(settings) });
      }).catch((error: unknown) => {
        set({ loadError: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        loadPromise = null;
        set({ isLoading: false });
      });
      return loadPromise;
    },

    update: async (key, value) => {
      const id = Symbol(key);
      const editValue = structuredClone(value);
      if (pending.size === 0) confirmed = get().settings;
      pending.set(key, { id, value: editValue });
      set((state) => ({
        settings: state.settings ? { ...state.settings, [key]: editValue } : null,
      }));
      await enqueue(async () => {
        try {
          confirmed = await electronSettingsApi.updateElectronSetting({ key, value: editValue });
        } catch (error) {
          toastError('Could not save setting', error);
        } finally {
          if (pending.get(key)?.id === id) pending.delete(key);
          if (confirmed) set({ settings: displaySettings(confirmed) });
        }
      });
    },

    reset: async () => {
      set({ isLoading: true });
      await enqueue(async () => {
        try {
          const defaults = await electronSettingsApi.resetElectronSettings();
          confirmed = defaults;
          const settings = displaySettings(defaults);
          set({ settings });
          applySettingsToUiStore(settings);
        } catch (error) {
          toastError('Could not reset settings', error);
        } finally {
          set({ isLoading: false });
        }
      });
    },
  };
});

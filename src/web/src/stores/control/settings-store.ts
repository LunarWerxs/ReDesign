import { ref } from 'vue';
import { httpJson } from '@/lib/httpClient';

interface SettingsSnapshot {
  version: string;
  autoUpdate: boolean;
  updateNotify: boolean;
  autoUpdateIntervalSecs: number;
  portableMode: boolean;
  hideTrayIcon: boolean;
  outputRetentionDays: number;
}

/** One settings snapshot for every pane; requests coalesce while Settings mounts its sections. */
export function createSettingsStore() {
  const autoUpdateEnabled = ref(false);
  const updateNotifyEnabled = ref(true);
  const appVersion = ref('');
  const portableModeEnabled = ref(false);
  const hideTrayIconEnabled = ref(false);
  const outputRetentionDays = ref(0);
  const outputBytes = ref(0);
  const settingsLoading = ref(false);
  const storageLoading = ref(false);
  let loading: Promise<SettingsSnapshot> | null = null;

  function absorb(s: SettingsSnapshot): SettingsSnapshot {
    autoUpdateEnabled.value = s.autoUpdate;
    updateNotifyEnabled.value = s.updateNotify;
    appVersion.value = s.version || '';
    portableModeEnabled.value = s.portableMode;
    hideTrayIconEnabled.value = s.hideTrayIcon;
    outputRetentionDays.value = s.outputRetentionDays;
    return s;
  }
  function loadSettings(force = false): Promise<SettingsSnapshot> {
    if (loading) return loading;
    settingsLoading.value = true;
    loading = httpJson<SettingsSnapshot>('/api/settings').then(absorb).finally(() => {
      loading = null;
      settingsLoading.value = false;
    });
    return loading;
  }
  async function updateSettings(patch: Partial<SettingsSnapshot>): Promise<SettingsSnapshot> {
    settingsLoading.value = true;
    try {
      return absorb(await httpJson<SettingsSnapshot>('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }));
    } finally {
      settingsLoading.value = false;
    }
  }
  async function loadStorage(): Promise<void> {
    storageLoading.value = true;
    try {
      outputBytes.value = (await httpJson<{ outputBytes: number }>('/api/settings/storage')).outputBytes;
    } finally { storageLoading.value = false; }
  }
  return { autoUpdateEnabled, updateNotifyEnabled, appVersion, portableModeEnabled, hideTrayIconEnabled,
    outputRetentionDays, outputBytes, settingsLoading, storageLoading, loadSettings, updateSettings, loadStorage };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;

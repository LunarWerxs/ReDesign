import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Silent auto-update (see src/auto-update.ts): a daemon-wide timer that checks the update remote
 * on a schedule and, only when the working tree is clean (`canApply`), applies the update and
 * restarts the server. ON by default since 2026-07-21; toggled via PUT /api/settings. Mirrors how
 * @/stores/control/sync.ts composes its own toggle.
 *
 * Also carries the running build's version, which rides along on the same GET /api/settings
 * payload and is displayed next to the update controls (Settings ▸ General ▸ Updates).
 */
export function createAutoUpdateSettingsActions() {
  const autoUpdateEnabled = ref(true);
  const autoUpdateLoading = ref(false); // initial load + toggle in flight
  const appVersion = ref('');

  /** Load the current setting (call on mount). Best-effort, leaves the default (on) on failure. */
  async function loadAutoUpdateSetting(): Promise<void> {
    autoUpdateLoading.value = true;
    try {
      const s = await api.getSettings();
      autoUpdateEnabled.value = s.autoUpdate;
      appVersion.value = s.version || '';
    } catch {
      /* non-critical, leave the default */
    } finally {
      autoUpdateLoading.value = false;
    }
  }

  /** Toggle auto-update (optimistic; rolls back on failure). */
  async function setAutoUpdate(enabled: boolean): Promise<void> {
    const prev = autoUpdateEnabled.value;
    autoUpdateEnabled.value = enabled;
    autoUpdateLoading.value = true;
    try {
      const s = await api.setAutoUpdate(enabled);
      autoUpdateEnabled.value = s.autoUpdate;
    } catch (e) {
      autoUpdateEnabled.value = prev; // roll back
      throw e;
    } finally {
      autoUpdateLoading.value = false;
    }
  }

  return { autoUpdateEnabled, autoUpdateLoading, appVersion, loadAutoUpdateSetting, setAutoUpdate };
}

import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Silent auto-update opt-in (see src/auto-update.ts): a daemon-wide timer that checks the update
 * remote on a schedule and, only when the working tree is clean (`canApply`), applies the update
 * and restarts the server. OFF by default; toggled via PUT /api/settings. Mirrors how
 * @/stores/control/sync.ts composes its own opt-in toggle.
 */
export function createAutoUpdateSettingsActions() {
  const autoUpdateEnabled = ref(false);
  const autoUpdateLoading = ref(false); // initial load + toggle in flight

  /** Load the current setting (call on mount). Best-effort, leaves the default (off) on failure. */
  async function loadAutoUpdateSetting(): Promise<void> {
    autoUpdateLoading.value = true;
    try {
      const s = await api.getSettings();
      autoUpdateEnabled.value = s.autoUpdate;
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

  return { autoUpdateEnabled, autoUpdateLoading, loadAutoUpdateSetting, setAutoUpdate };
}

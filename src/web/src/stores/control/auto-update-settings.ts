import { ref } from 'vue';
import { api } from '@/lib/api';

/**
 * Auto-update settings (see src/auto-update.ts): a daemon-wide timer that checks the update
 * remote on a schedule. Two independent opt-ins share it:
 *   · updateNotify — tells the UI when an update is available (GET /api/events). ON by default.
 *   · autoUpdate   — additionally applies the update and restarts the server, unattended, only
 *     when the working tree is clean (`canApply`). OFF by default since 2026-08-11; only an
 *     explicit `true` turns it on.
 * Both toggled via PUT /api/settings. Mirrors how @/stores/control/sync.ts composes its own toggle.
 *
 * Also carries the running build's version, which rides along on the same GET /api/settings
 * payload and is displayed next to the update controls (Settings ▸ General ▸ Updates).
 */
export function createAutoUpdateSettingsActions() {
  const autoUpdateEnabled = ref(false);
  const updateNotifyEnabled = ref(true);
  const autoUpdateLoading = ref(false); // initial load + either toggle in flight
  const appVersion = ref('');

  /** Load both settings (call on mount). Best-effort, leaves the defaults on failure. */
  async function loadAutoUpdateSetting(): Promise<void> {
    autoUpdateLoading.value = true;
    try {
      const s = await api.getSettings();
      autoUpdateEnabled.value = s.autoUpdate;
      updateNotifyEnabled.value = s.updateNotify;
      appVersion.value = s.version || '';
    } catch {
      /* non-critical, leave the defaults */
    } finally {
      autoUpdateLoading.value = false;
    }
  }

  /** Toggle silent auto-apply (optimistic; rolls back on failure). */
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

  /** Toggle "tell me about updates" (optimistic; rolls back on failure). */
  async function setUpdateNotify(enabled: boolean): Promise<void> {
    const prev = updateNotifyEnabled.value;
    updateNotifyEnabled.value = enabled;
    autoUpdateLoading.value = true;
    try {
      const s = await api.setUpdateNotify(enabled);
      updateNotifyEnabled.value = s.updateNotify;
    } catch (e) {
      updateNotifyEnabled.value = prev; // roll back
      throw e;
    } finally {
      autoUpdateLoading.value = false;
    }
  }

  return {
    autoUpdateEnabled,
    updateNotifyEnabled,
    autoUpdateLoading,
    appVersion,
    loadAutoUpdateSetting,
    setAutoUpdate,
    setUpdateNotify,
  };
}

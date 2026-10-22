import type { SettingsStore } from './settings-store';

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
export function createAutoUpdateSettingsActions(settings: SettingsStore) {

  /** Load both settings (call on mount). Best-effort, leaves the defaults on failure. */
  async function loadAutoUpdateSetting(): Promise<void> {
    await settings.loadSettings();
  }

  /** Toggle silent auto-apply (optimistic; rolls back on failure). */
  async function setAutoUpdate(enabled: boolean): Promise<void> {
    await settings.updateSettings({ autoUpdate: enabled });
  }

  /** Toggle "tell me about updates" (optimistic; rolls back on failure). */
  async function setUpdateNotify(enabled: boolean): Promise<void> {
    await settings.updateSettings({ updateNotify: enabled });
  }

  return {
    autoUpdateEnabled: settings.autoUpdateEnabled,
    updateNotifyEnabled: settings.updateNotifyEnabled,
    autoUpdateLoading: settings.settingsLoading,
    appVersion: settings.appVersion,
    loadAutoUpdateSetting,
    setAutoUpdate,
    setUpdateNotify,
  };
}

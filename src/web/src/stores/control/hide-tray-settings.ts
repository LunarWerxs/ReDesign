import type { SettingsStore } from './settings-store';

/**
 * Hide-tray-icon opt-in (see misc/ReDesign-Tray.ps1): hides the notification-area icon while
 * leaving the daemon, watchdog, and menu/quit machinery running untouched. OFF by default;
 * toggled via PUT /api/settings. The tray host re-reads runtime.json on its health timer, so a
 * change here reaches it within a few seconds without a restart. Mirrors
 * @/stores/control/portable-mode-settings.ts.
 */
export function createHideTraySettingsActions(settings: SettingsStore) {

  /** Load the current setting (call on mount). Best-effort, leaves the default (off) on failure. */
  async function loadHideTrayIconSetting(): Promise<void> {
    await settings.loadSettings();
  }

  /** Toggle hide-tray-icon (optimistic; rolls back on failure). */
  async function setHideTrayIcon(enabled: boolean): Promise<void> {
    await settings.updateSettings({ hideTrayIcon: enabled });
  }

  return { hideTrayIconEnabled: settings.hideTrayIconEnabled, hideTrayIconLoading: settings.settingsLoading, loadHideTrayIconSetting, setHideTrayIcon };
}

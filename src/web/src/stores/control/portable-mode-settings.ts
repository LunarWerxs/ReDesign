import type { SettingsStore } from './settings-store';

/**
 * Portable window opt-in (see src/portable-window.mjs): opens the app UI in a chromeless
 * Chromium app window instead of a normal browser tab, both from this toggle and from the
 * tray/start.cmd launcher, which reads the same setting back out of runtime.json. OFF by
 * default; toggled via PUT /api/settings. Mirrors @/stores/control/auto-update-settings.ts.
 */
export function createPortableModeSettingsActions(settings: SettingsStore) {

  /** Load the current setting (call on mount). Best-effort, leaves the default (off) on failure. */
  async function loadPortableModeSetting(): Promise<void> {
    await settings.loadSettings();
  }

  /** Toggle portable mode (optimistic; rolls back on failure). */
  async function setPortableMode(enabled: boolean): Promise<void> {
    await settings.updateSettings({ portableMode: enabled });
  }

  return { portableModeEnabled: settings.portableModeEnabled, portableModeLoading: settings.settingsLoading, loadPortableModeSetting, setPortableMode };
}

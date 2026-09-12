import type { SettingsStore } from './settings-store';

/**
 * Output retention (see src/store.ts / http/routes/settings.ts): how long a finished run's output
 * files stay on disk before a cleanup sweep removes them. 0 (the default) keeps every run forever.
 * The sweep itself only runs once at server startup, so a lowered value takes effect on the next
 * launch, not immediately — see Settings ▸ General ▸ Output storage.
 *
 * `outputBytes` rides along on the same GET/PUT /api/settings payload as a read-only disk-usage
 * readout for that same settings row (walked on demand server-side, store.ts outputBytes()).
 * Mirrors @/stores/control/auto-update-settings.ts and portable-mode-settings.ts.
 */
export function createOutputRetentionSettingsActions(settings: SettingsStore) {

  /** Load the current setting + disk usage (call on mount). Best-effort, leaves the defaults on failure. */
  async function loadOutputRetentionSetting(): Promise<void> {
    await settings.loadSettings();
  }

  /** Change the retention window (optimistic; rolls back on failure). 0 means keep forever. */
  async function setOutputRetentionDays(days: number): Promise<void> {
    await settings.updateSettings({ outputRetentionDays: days });
  }

  return {
    outputRetentionDays: settings.outputRetentionDays,
    outputBytes: settings.outputBytes,
    outputRetentionLoading: settings.settingsLoading,
    loadOutputRetentionSetting,
    setOutputRetentionDays,
    loadOutputStorage: settings.loadStorage,
  };
}

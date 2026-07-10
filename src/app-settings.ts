/**
 * Local daemon settings that aren't secrets and aren't per-user cloud-synced content (that's
 * src/connections.ts's `appearance` blob). Currently just the auto-update opt-in (see
 * src/auto-update.ts): whether the daemon self-updates + restarts on a schedule, and the check
 * cadence. Persisted alongside the other small local state files under output/ (pulse install id,
 * Connections refresh token), never inside the tracked repo.
 */
import path from "node:path";
import { ROOT, readJSON, writeJSON } from "./util";
import { AUTO_UPDATE_INTERVAL_DEFAULT_S } from "./auto-update";

const SETTINGS_FILE = path.join(ROOT, "output", ".reimagine-settings.json");

export interface AppSettings {
  /**
   * Auto-update the app on a schedule: check the update remote, and when a newer commit is
   * available AND the working tree is clean (canApply), pull + reinstall + rebuild, then
   * self-relaunch so the new code takes over, see src/auto-update.ts. Absent/false = OFF
   * (opt-in): it restarts the daemon unattended. A dirty tree is never updated.
   */
  autoUpdate?: boolean;
  /** Auto-update check cadence in seconds. Clamped to [900, 604800]; absent = 21600 (6 h). */
  autoUpdateIntervalSecs?: number;
}

let cached: AppSettings | null = null;

/** Load the persisted settings (cached in-memory after the first read). */
export function loadAppSettings(): AppSettings {
  if (!cached) cached = readJSON<AppSettings>(SETTINGS_FILE, {});
  return cached;
}

/** Persist the settings object (call after mutating the object returned by loadAppSettings()). */
export function saveAppSettings(settings: AppSettings): void {
  cached = settings;
  writeJSON(SETTINGS_FILE, settings);
}

export { AUTO_UPDATE_INTERVAL_DEFAULT_S };
export { SETTINGS_FILE };

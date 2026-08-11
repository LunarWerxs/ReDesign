/**
 * Local daemon settings that aren't secrets and aren't per-user cloud-synced content (that's
 * src/connections.ts's `appearance` blob). Currently the auto-update notify + auto-apply opt-ins
 * (see src/auto-update.ts): whether the daemon tells the UI about an update, whether it also
 * self-updates + restarts unattended, and the check cadence. Persisted alongside the other small
 * local state files under output/ (pulse install id, Connections refresh token), never inside the
 * tracked repo.
 */
import path from "node:path";
import { ROOT, readJSON, writeJSON } from "./util";
import { AUTO_UPDATE_INTERVAL_DEFAULT_S } from "./auto-update";

const SETTINGS_FILE = path.join(ROOT, "output", ".reimagine-settings.json");

export interface AppSettings {
  /**
   * Silently auto-update the app on a schedule: check the update remote, and when a newer commit
   * is available AND the working tree is clean (canApply), pull + reinstall + rebuild, then
   * self-relaunch so the new code takes over, see src/auto-update.ts. OFF by default since
   * 2026-08-11 (previously on-by-default 2026-07-21 → 2026-08-11): absent/undefined means
   * notify-only (see `updateNotify` below), only an explicit `true` (the settings toggle) opts
   * into unattended installs; an explicit `false` disables it outright. A dirty tree is never
   * updated, and a pending restart waits for any active run to finish.
   */
  autoUpdate?: boolean;
  /**
   * Tell the UI when an update is available (src/auto-update.ts's notify path, delivered over
   * GET /api/events). ON by default: absent = ON, only an explicit `false` turns it off. This is
   * the always-on half of the policy — the periodic check runs whenever this OR `autoUpdate` is
   * on, and this alone never installs anything; it just surfaces an "Update now" offer.
   */
  updateNotify?: boolean;
  /** Auto-update check cadence in seconds. Clamped to [900, 604800]; absent = 21600 (6 h). */
  autoUpdateIntervalSecs?: number;
  /**
   * Open the app UI in a chromeless Chromium app window (msedge/chrome --app=URL) instead of a
   * normal browser tab, both from the in-app toggle and from the tray/start.cmd launcher (see
   * src/portable-window.mjs, POST /api/portable-window). Absent/false = OFF (a normal tab).
   */
  portableMode?: boolean;
  /**
   * Hide the tray notification-area icon (see misc/ReDesign-Tray.ps1). The NotifyIcon object is
   * always created (Quit/menu/watchdog hang off it); only its .Visible is gated. Absent/false =
   * OFF (icon shown). The daemon keeps running either way; re-enable here or relaunch the
   * shortcut to get the UI back.
   */
  hideTrayIcon?: boolean;
  /**
   * Delete finished runs older than this many days, swept once at boot (see store.pruneRuns and
   * the call in http/serve.ts). Absent or 0 = keep everything forever, which is the default and
   * the historical behaviour: nothing has ever removed a run except the user deleting it, so
   * output/ grows without bound. OPT-IN on purpose, deleting someone's saved work on a timer is
   * not something to switch on for them. Clamped to [1, 3650] when set.
   */
  outputRetentionDays?: number;
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

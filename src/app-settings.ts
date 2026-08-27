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

/**
 * Drop the in-memory cache so the next `loadAppSettings()` re-reads the file.
 *
 * A test seam, and a narrow one: the cache means DELETING the settings file is not enough to get
 * default behaviour back, which is exactly what `tests/app-settings.test.ts` assumed it did. That
 * test passed only for as long as no other test file had ever loaded settings first — a second
 * one arriving was all it took, and the failure looks like the new file's fault rather than the
 * assumption's. Nothing in the app calls this; the daemon has one settings owner and one process.
 */
export function resetAppSettingsCache(): void {
  cached = null;
}

// ── what travels to a Connections account ────────────────────────────────────────
//
// Added 2026-08-25. Until then `connections.ts` synced ONLY the browser's theme, on the stated
// grounds that "Reimagine's only portable per-user preference is its APPEARANCE". That was true
// when it was written and stopped being true the moment this file existed: six daemon preferences
// accumulated here, none of them secret, none of them machine-specific, and not one of them
// followed the user to a second machine.

/** Preferences that DO travel: portable statements of what the owner wants, with no side effect
 *  the moment they land. */
export const SYNCED_PREF_KEYS = [
  "updateNotify", // surfaces an offer; installs nothing on its own
  "autoUpdateIntervalSecs", // a cadence, and only meaningful where checking was opted into
  "portableMode", // chromeless window vs a browser tab
  "hideTrayIcon", // notification-area icon on or off
] as const satisfies readonly (keyof AppSettings)[];

/** Preferences that deliberately do NOT travel, with the reason each one doesn't. */
export const NEVER_SYNCED_PREF_KEYS = [
  // Unattended: pulls, reinstalls, rebuilds and RESTARTS the daemon with nobody watching. A
  // machine someone just signed in on must not start doing that because another one was told to.
  "autoUpdate",
  // Unattended AND destructive: it deletes finished runs older than N days at boot. Its own
  // comment above says switching that on for someone is not something to do for them, and
  // arriving over the wire is the most for-them way it could possibly be switched on.
  "outputRetentionDays",
] as const satisfies readonly (keyof AppSettings)[];

/**
 * Compile-time proof that the two lists partition `AppSettings`.
 *
 * A new preference that belongs to neither fails this line, and the error names it. That check is
 * the actual fix here — widening the list once only helps until the next preference is added, and
 * "not synced" being the silent default is what stranded these six in the first place.
 */
type UnclassifiedPrefKey = Exclude<
  keyof AppSettings,
  (typeof SYNCED_PREF_KEYS)[number] | (typeof NEVER_SYNCED_PREF_KEYS)[number]
>;
const _everyPrefIsClassified: UnclassifiedPrefKey extends never
  ? true
  : [
      "these AppSettings keys sync neither way — add each to SYNCED_PREF_KEYS or NEVER_SYNCED_PREF_KEYS",
      UnclassifiedPrefKey,
    ] = true;
void _everyPrefIsClassified;

/** The synced subset of the current settings, as the flat object that goes on the wire. */
export function readSyncedPrefs(): Record<string, unknown> {
  const settings = loadAppSettings() as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

/**
 * Apply an incoming prefs blob, keeping only allowlisted keys. Returns whether anything changed.
 *
 * Filtering on the way IN as well as out is the half that matters for safety: a doc written by a
 * newer build — or tampered with — must not be able to switch on unattended self-updating or
 * timed deletion of the owner's runs just because it names those keys.
 */
export function applySyncedPrefs(prefs: unknown): boolean {
  if (!prefs || typeof prefs !== "object") return false;
  const incoming = prefs as Record<string, unknown>;
  const settings = loadAppSettings();
  const target = settings as Record<string, unknown>;
  let changed = false;
  for (const key of SYNCED_PREF_KEYS) {
    const value = incoming[key];
    if (value === undefined || Object.is(value, target[key])) continue;
    target[key] = value;
    changed = true;
  }
  if (changed) saveAppSettings(settings);
  return changed;
}

export { AUTO_UPDATE_INTERVAL_DEFAULT_S };
export { SETTINGS_FILE };

/**
 * GET/PUT /api/settings, local daemon settings that aren't secrets and aren't the Connections
 * cloud-synced appearance blob (that's /api/settings/sync, see routes/connections.ts). Currently
 * the auto-update opt-in + cadence (see src/auto-update.ts, src/app-settings.ts) and the portable
 * window opt-in (src/portable-window.mjs). Mirrors RepoYeti's PUT /api/settings shape/pattern,
 * scoped down to what RēDesign actually has.
 *
 * Also owns POST /api/portable-window: opens this daemon's own live URL in a chromeless Chromium
 * app window, used both by the settings toggle (turning portableMode on) and, in principle, by
 * anything else in the UI that wants to pop the app into its own window on demand.
 */
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin, PORT, HOST } from "../origin-guard";
import { ROOT, readJSON } from "../../util";
import { loadAppSettings, saveAppSettings } from "../../app-settings";
import { readInstanceInfo, updateInstanceInfo, instanceFilePath } from "../../instance";
import { openPortableWindow } from "../../portable-window.mjs";
import { WINDOW_SIZE_HINT_PARAM, windowSizeHintFor } from "../../window-size";
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
} from "../../auto-update";

/**
 * First-run outer size of the portable app window (what Chromium's `--window-size` takes).
 * Only applies to a window the dedicated profile has NEVER seen — the kit's
 * openPortableWindow probes the profile's saved placement first, so a size the user picked
 * themselves (or a maximize) wins on every later launch. Without it a never-seen window
 * opens at Chromium's default of ~the whole work area (~1905x2092 on a 4K display).
 *
 * Measured against the real Control page, not guessed. Width: the layout hard-caps content
 * at `--container-max` = 800px (src/web/src/styles/kit-base.css, applied by
 * src/web/src/shell/AppContainer.vue), so 800px container + 15px scrollbar + ~16px frame =
 * 831 outer is the floor below which the design width gets cropped. Height is a density
 * pick sized for the working state, not the empty one: the first-run stack (58px topbar +
 * Inputs + Options + footer) is only ~500px, but starting a run inserts a ProgressCard
 * below it — a 718px viewport keeps the full input/options stack visible plus a ~200px
 * first slice of that card — 760 outer (outer = viewport + ~34 title + ~8 frame height;
 * Chromium draws its title bar inside the client area). The tray and start.cmd launchers
 * carry the same numbers (misc/ReDesign-Tray.ps1 PortableWindowSize, misc/Open-Ui.ps1) —
 * keep all three in step.
 */
export const PORTABLE_WINDOW_SIZE = { width: 840, height: 760 };

/**
 * The running build's version, straight out of package.json — what Settings ▸ General shows so
 * "what am I on?" is answerable without opening a terminal. Read once and memoised: the file
 * can't change under a running daemon, and a self-update relaunches the process anyway. Empty
 * string when the file isn't there (a compiled binary whose ROOT is the exe dir), which the UI
 * renders as "unknown" rather than a blank row.
 */
let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion === null) {
    cachedVersion = String(readJSON<{ version?: string }>(join(ROOT, "package.json"), {}).version || "");
  }
  return cachedVersion;
}

function snapshot() {
  return {
    version: appVersion(),
    autoUpdate: autoUpdateEnabled(),
    autoUpdateIntervalSecs: getAutoUpdateIntervalSecs(),
    portableMode: loadAppSettings().portableMode === true,
    hideTrayIcon: loadAppSettings().hideTrayIcon === true,
  };
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/settings", (c) => c.json({ ok: true, ...snapshot() }));

  app.put("/api/settings", requireSameOrigin(), async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
    const settings = loadAppSettings();

    // Toggling this starts/stops the daemon-wide auto-update timer (see auto-update.ts).
    if (typeof b.autoUpdate === "boolean") {
      settings.autoUpdate = b.autoUpdate;
      setAutoUpdateEnabled(b.autoUpdate);
      saveAppSettings(settings);
    }
    if (typeof b.autoUpdateIntervalSecs === "number" && Number.isFinite(b.autoUpdateIntervalSecs)) {
      // setAutoUpdateIntervalSecs clamps to [900, 604800], persist the clamped value, not the raw input.
      settings.autoUpdateIntervalSecs = setAutoUpdateIntervalSecs(b.autoUpdateIntervalSecs);
      saveAppSettings(settings);
    }
    if (typeof b.portableMode === "boolean") {
      settings.portableMode = b.portableMode;
      saveAppSettings(settings);
      // Keep runtime.json current so the tray/start.cmd launcher picks up the change on its
      // next open, without waiting for a daemon restart (see src/instance.ts / instance-pointer.mjs).
      updateInstanceInfo({ portableMode: b.portableMode });
    }
    if (typeof b.hideTrayIcon === "boolean") {
      settings.hideTrayIcon = b.hideTrayIcon;
      saveAppSettings(settings);
      // Keep runtime.json current so the tray host's live-sync timer (misc/ReDesign-Tray.ps1)
      // picks up the change within a few seconds, without restarting anything.
      updateInstanceInfo({ hideTrayIcon: b.hideTrayIcon });
    }

    return c.json({ ok: true, ...snapshot() });
  });

  // Open this daemon's OWN live URL in a chromeless app window. Prefers the runtime pointer's
  // recorded url (the port the daemon actually bound, which may have hopped past the preferred
  // PORT), falling back to the preferred HOST/PORT if the pointer is missing/stale. Gets its own
  // dedicated Chromium profile (a sibling of runtime.json) so the window remembers its own
  // size/position across launches; the tray/start.cmd launchers derive the same path.
  app.post("/api/portable-window", requireSameOrigin(), async (c) => {
    const url = readInstanceInfo()?.url || `http://${HOST}:${PORT}`;
    const profileDir = join(dirname(instanceFilePath()), "portable-profile");
    // First-run size only — openPortableWindow yields to the profile's saved placement once
    // the user has resized the window themselves (see PORTABLE_WINDOW_SIZE above). A forwarded
    // --app launch (a window already open on this profile) ignores --window-size AND the saved
    // placement, so also tag the URL with the size this window should have and the page
    // corrects itself with resizeTo (src/web/src/lib/window-size-hint.ts). The query string is
    // not part of Chromium's placement key; a URL that won't parse just goes out un-hinted.
    let target = url;
    try {
      const hint = windowSizeHintFor(profileDir, url, PORTABLE_WINDOW_SIZE);
      if (hint) {
        const u = new URL(url);
        u.searchParams.set(WINDOW_SIZE_HINT_PARAM, hint);
        target = u.toString();
      }
    } catch {
      /* unparseable base URL: open it un-hinted rather than fail the route */
    }
    const result = await openPortableWindow(target, { profileDir, initialSize: PORTABLE_WINDOW_SIZE });
    return c.json(result);
  });
}

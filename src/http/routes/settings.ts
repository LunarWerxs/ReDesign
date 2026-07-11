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
import { loadAppSettings, saveAppSettings } from "../../app-settings";
import { readInstanceInfo, updateInstanceInfo, instanceFilePath } from "../../instance";
import { openPortableWindow } from "../../portable-window.mjs";
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
} from "../../auto-update";

function snapshot() {
  return {
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
    const result = await openPortableWindow(url, { profileDir });
    return c.json(result);
  });
}

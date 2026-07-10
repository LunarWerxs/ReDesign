/**
 * GET/PUT /api/settings, local daemon settings that aren't secrets and aren't the Connections
 * cloud-synced appearance blob (that's /api/settings/sync, see routes/connections.ts). Currently
 * just the auto-update opt-in + cadence (see src/auto-update.ts, src/app-settings.ts). Mirrors
 * RepoYeti's PUT /api/settings shape/pattern, scoped down to what RēDesign actually has.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { loadAppSettings, saveAppSettings } from "../../app-settings";
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

    return c.json({ ok: true, ...snapshot() });
  });
}

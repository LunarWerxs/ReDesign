/**
 * HTTP surface (Hono) composition root. Mirrors RepoYeti's src/http/app.ts: wires per-domain
 * route modules onto one Hono app, then mounts the static web UI LAST so its `/*` catch-all only
 * catches routes no earlier module owned. Replaces server.js + server/fileServing.js.
 *
 * A handful of routes (models/prompts/keys mutation, output/open, key CRUD) still throw a
 * `{status}`-carrying Error on validation failure, same shape server.js's routes used with its
 * manual `try { ... } catch (err) { sendJSON(res, err.status||500, {error: err.message}) }`
 * wrapper. app.onError() below reproduces that exact catch-all so those routes don't need to be
 * rewritten to return Response objects on every error path.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mountWeb } from "./web";
import { requireSameOrigin } from "./origin-guard";
import type { Deps } from "./deps";
import * as bootstrap from "./routes/bootstrap";
import * as inputs from "./routes/inputs";
import * as prompts from "./routes/prompts";
import * as models from "./routes/models";
import * as keys from "./routes/keys";
import * as runs from "./routes/runs";
import * as updates from "./routes/updates";
import * as health from "./routes/health";
import * as output from "./routes/output";
import * as connections from "./routes/connections";
import * as costs from "./routes/costs";
import * as settingsRoute from "./routes/settings";
import { loadAppSettings } from "../app-settings";
import { writeShutdownRequest } from "../instance";
import { setAutoUpdateEnabled, setAutoUpdateIntervalSecs, AUTO_UPDATE_INTERVAL_DEFAULT_S } from "../auto-update";

interface StatusError extends Error {
  status?: number;
  statusCode?: number;
}

export interface AppHooks {
  requestShutdown?: () => void;
}

export function createApp(hooks: AppHooks = {}): Hono {
  // Auto-update: ON by default (2026-07-21) → only an explicit `false` turns it off, so an
  // install that never touched the toggle stays current on its own. The timer only STARTS after
  // boot (startAutoUpdate in cli/lifecycle.ts); this just primes the runtime flags from the
  // persisted settings file (see src/app-settings.ts), createApp() in tests never spins a real timer.
  const settings = loadAppSettings();
  setAutoUpdateEnabled(settings.autoUpdate !== false);
  setAutoUpdateIntervalSecs(settings.autoUpdateIntervalSecs ?? AUTO_UPDATE_INTERVAL_DEFAULT_S);

  const app = new Hono();

  const deps: Deps = { requestShutdown: hooks.requestShutdown || (() => {}) };

  // Register every route module. Registration order mirrors server.js's original if/else-if
  // dispatch order (bootstrap/pulse, inputs, prompts, models, keys, runs, updates, health-check,
  // output, then the Connections OAuth + settings-sync routes, registered before the SPA
  // fallback so its GET /oauth/* navigations aren't swallowed by it, then costs, then mountWeb LAST).
  bootstrap.register(app, deps);
  inputs.register(app, deps);
  prompts.register(app, deps);
  models.register(app, deps);
  keys.register(app, deps);
  runs.register(app, deps);
  updates.register(app, deps);
  health.register(app, deps);
  output.register(app, deps);
  connections.register(app, deps);
  costs.register(app, deps);
  settingsRoute.register(app, deps);

  // POST /api/shutdown, kept here (not a dedicated routes/system.ts, per the doc) since it's a
  // one-liner wired straight to the graceful-shutdown hook the CLI lifecycle owns. Mirrors
  // server.js: respond first, then close the listener on a short unref'd timer so the response
  // has a chance to flush before the process exits.
  app.post("/api/shutdown", requireSameOrigin(), (c) => {
    // The tray stops the daemon by port (Stop-Server) and never calls this route, so any request
    // that reaches here is a user "Shut Down" from the web UI (or `redesign stop`) — a request to
    // terminate the WHOLE app, tray included. Drop a sentinel the tray host polls so it disposes its
    // notification-area icon and exits too; harmless when no tray is running (cleared on next boot).
    writeShutdownRequest();
    setTimeout(() => deps.requestShutdown?.(), 50).unref?.();
    return c.json({ ok: true });
  });

  // Static PWA, LAST, so the `/*` catch-all only catches non-API, non-static-file routes.
  mountWeb(app);

  app.onError((err, c) => {
    const e = err as StatusError;
    const status = e.status || e.statusCode || 500;
    return c.json({ error: e.message }, status as ContentfulStatusCode);
  });

  return app;
}

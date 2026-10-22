/**
 * GET /api/updates, POST /api/updates/apply. Ported from server.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import * as updater from "../../updater";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/updates", async (c) => {
    const status = await updater.checkForUpdate();
    return c.json(status);
  });

  app.post("/api/updates/apply", requireSameOrigin(), async (c) => {
    try {
      const result = await updater.applyUpdate();
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}

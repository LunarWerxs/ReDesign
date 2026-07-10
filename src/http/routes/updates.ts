/**
 * GET /api/updates, POST /api/updates/apply. Ported from server.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { recordPulse } from "./bootstrap";
import * as updater from "../../updater";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/updates", async (c) => {
    const status = await updater.checkForUpdate();
    void recordPulse("update_check", {
      available: status.updateAvailable,
      canApply: status.canApply,
      reason: status.reason,
    });
    return c.json(status);
  });

  app.post("/api/updates/apply", requireSameOrigin(), async (c) => {
    try {
      void recordPulse("update_apply_clicked");
      const result = await updater.applyUpdate();
      void recordPulse("update_apply_result", {
        ok: result.ok,
        restartRequired: result.restartRequired,
      });
      return c.json(result);
    } catch (err) {
      void recordPulse("update_apply_result", {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}

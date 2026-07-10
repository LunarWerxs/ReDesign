/**
 * POST /api/health-check, abortable via client disconnect. Ported from server.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { getKeyManager } from "../../runner";
import { resolveModels } from "../../config";
import { healthCheckModel, type HealthCheckResult } from "../../healthCheck";
import { filteredKeySnapshot } from "../../server/settings";

interface CancelledLike {
  status?: number;
  cancelled?: boolean;
  name?: string;
}

export function register(app: Hono, _deps: Deps): void {
  app.post("/api/health-check", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { models?: unknown };
    const controller = new AbortController();
    // Hono's request signal fires when the client disconnects, abort the in-flight pings so a
    // cancelled health check doesn't keep spending quota after the browser tab closes.
    c.req.raw.signal.addEventListener("abort", () => controller.abort());

    const km = getKeyManager();
    const models = resolveModels((body.models as any) || "all");
    const results: HealthCheckResult[] = [];
    try {
      for (const m of models) {
        if (controller.signal.aborted) {
          const err = new Error("health check cancelled") as Error & CancelledLike;
          err.status = 499;
          err.cancelled = true;
          throw err;
        }
        results.push(await healthCheckModel(km, m, { signal: controller.signal }));
      }
      return c.json({ results, keys: filteredKeySnapshot(km) });
    } catch (err) {
      const e = err as CancelledLike & Error;
      if (controller.signal.aborted || e?.cancelled || e?.name === "AbortError") {
        return c.json({ cancelled: true, error: "health check cancelled", results, keys: filteredKeySnapshot(km) }, 499 as any);
      }
      throw err;
    }
  });
}

/**
 * GET /api/costs, spend-to-date aggregate (sum across stored runs) for the key
 * health sheet. POST /api/costs/estimate, pre-run "≈ $X" estimate for the run
 * UI, BEFORE launching a run. Additive: reuses each run's manifest-computed
 * `cost` (see src/runner/cost.ts spendToDate()/estimateRunCost()), same
 * run-listing options as GET /api/runs.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { spendToDate, estimateRunCost } from "../../runner";
import { runStoreOptions } from "../runQueue";

interface EstimateBody {
  modelIds?: unknown;
  jobCount?: unknown;
  jobCountByModel?: unknown;
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/costs", (c) => c.json(spendToDate(runStoreOptions())));

  app.post("/api/costs/estimate", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as EstimateBody;
    const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map(String).filter(Boolean) : [];
    const jobCount = Math.max(0, parseInt(String(body.jobCount), 10) || 0);
    // Optional per-model job counts (per-model quantity feature): keeps the estimate
    // accurate when different models run a different number of copies. Missing/omitted
    // falls back to estimateRunCost's even split across modelIds.
    let jobCountByModel: Record<string, number> | undefined;
    if (body.jobCountByModel && typeof body.jobCountByModel === "object") {
      jobCountByModel = {};
      for (const [id, v] of Object.entries(body.jobCountByModel as Record<string, unknown>)) {
        jobCountByModel[id] = Math.max(0, parseInt(String(v), 10) || 0);
      }
    }
    return c.json(estimateRunCost({ modelIds, jobCount, jobCountByModel }, runStoreOptions()));
  });
}

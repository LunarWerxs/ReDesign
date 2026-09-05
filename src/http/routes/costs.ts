/**
 * GET /api/costs, spend-to-date aggregate (sum across stored runs) for the key
 * health sheet. POST /api/costs/estimate, pre-run "≈ $X" estimate for the run
 * UI, BEFORE launching a run. GET /api/costs/traces, per-generation AI
 * observability: the most recent jobs across stored runs as normalized
 * traces (latency/tokens/cost/error) plus a by-model rollup - the thing the
 * spend total above can never show (see src/runner/cost.ts recentTraces()).
 * Additive: reuses each run's manifest-computed `cost` (see src/runner/cost.ts
 * spendToDate()/estimateRunCost()), same run-listing options as GET /api/runs.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { spendToDate, estimateRunCost, recentTraces } from "../../runner";
import { runStoreOptions } from "../runQueue";

interface EstimateBody {
  modelIds?: unknown;
  jobCount?: unknown;
  jobCountByModel?: unknown;
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/costs", (c) => c.json(spendToDate(runStoreOptions())));

  app.post("/api/costs/estimate", requireSameOrigin(), async (c) => {
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

  // ?runs=N caps how many recent stored runs are scanned for traces (default set by
  // recentTraces itself); clamped so a bad/huge query value can't force a slow full scan.
  app.get("/api/costs/traces", (c) => {
    const runsParam = c.req.query("runs");
    const runLimit = runsParam ? Math.min(100, Math.max(1, parseInt(runsParam, 10) || 0)) : undefined;
    return c.json(runLimit ? recentTraces(runStoreOptions(), runLimit) : recentTraces(runStoreOptions()));
  });
}

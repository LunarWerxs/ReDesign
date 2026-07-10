// Run Cost Meter math: turns a provider's raw `usage` blob (three different
// shapes, Anthropic, OpenAI-compatible, Gemini, plus the mock stand-in) into
// normalized input/output token counts, then prices them against
// src/config/pricing.json. Additive-only: every helper here is read-only math,
// never mutates the manifest/job it's given.

import { priceForModel, pricingLastUpdated } from "../config/pricing";
import * as store from "../store";

interface NormalizedTokens {
  inputTokens: number;
  outputTokens: number;
}

interface CostBreakdown extends NormalizedTokens {
  modelId: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  estimate: boolean; // true if the model's price entry is a guess (pricing.json `estimate:true`)
  priced: boolean; // false if no pricing entry exists for this model (cost is 0, not "free")
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Normalize any provider's `usage` object to { inputTokens, outputTokens }.
 * Recognizes:
 *   - Anthropic:        { input_tokens, output_tokens }
 *   - OpenAI-compatible: { prompt_tokens, completion_tokens }
 *   - Gemini:           { promptTokenCount, candidatesTokenCount }
 *   - mock adapter:     { mock: true, input_tokens, output_tokens }
 * Unrecognized/missing usage normalizes to zeros (cost math stays additive/safe).
 */
function normalizeUsage(usage: unknown): NormalizedTokens {
  if (!usage || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const u = usage as Record<string, unknown>;
  const inputTokens = num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  const outputTokens = num(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount);
  return { inputTokens, outputTokens };
}

/**
 * Price one job's usage against the model's pricing.json entry.
 * priced=false (and totalCost=0) when the model has no pricing entry at all, 
 * distinct from a model that is priced but simply used zero tokens.
 */
function costForUsage(modelId: string, usage: unknown): CostBreakdown {
  const { inputTokens, outputTokens } = normalizeUsage(usage);
  const price = priceForModel(modelId);
  if (!price) {
    return { modelId, inputTokens, outputTokens, inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD", estimate: false, priced: false };
  }
  const inputCost = (inputTokens / 1_000_000) * price.inputPerMtok;
  const outputCost = (outputTokens / 1_000_000) * price.outputPerMtok;
  return {
    modelId,
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: price.currency || "USD",
    estimate: !!price.estimate,
    priced: true,
  };
}

interface RunCostJobLike {
  modelId: string;
  usage?: unknown;
  status?: string;
}

interface RunCostManifestLike {
  jobs?: RunCostJobLike[];
}

interface RunCostResult {
  totalCost: number;
  currency: string;
  jobCount: number; // jobs that actually carried usage and contributed to totalCost
  anyEstimatePricing: boolean; // true if any contributing model's price is a guess
  anyUnpriced: boolean; // true if any job's model has no pricing.json entry
  byModel: Record<string, { totalCost: number; inputTokens: number; outputTokens: number }>;
}

/** Sum cost across every job in a manifest that carries a `usage` blob. */
function runCost(manifest: RunCostManifestLike | null | undefined): RunCostResult {
  const byModel: Record<string, { totalCost: number; inputTokens: number; outputTokens: number }> = {};
  let totalCost = 0;
  let jobCount = 0;
  let anyEstimatePricing = false;
  let anyUnpriced = false;
  const jobs = Array.isArray(manifest?.jobs) ? (manifest as RunCostManifestLike).jobs! : [];

  for (const job of jobs) {
    if (!job || !job.usage) continue;
    const breakdown = costForUsage(job.modelId, job.usage);
    jobCount++;
    totalCost += breakdown.totalCost;
    if (breakdown.estimate) anyEstimatePricing = true;
    if (!breakdown.priced) anyUnpriced = true;
    const entry = byModel[job.modelId] || { totalCost: 0, inputTokens: 0, outputTokens: 0 };
    entry.totalCost += breakdown.totalCost;
    entry.inputTokens += breakdown.inputTokens;
    entry.outputTokens += breakdown.outputTokens;
    byModel[job.modelId] = entry;
  }

  return { totalCost, currency: "USD", jobCount, anyEstimatePricing, anyUnpriced, byModel };
}

interface SpendToDateResult {
  totalCost: number;
  currency: string;
  runCount: number; // runs that contributed at least one priced job
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
  pricingLastUpdated: string | null;
}

/**
 * Sum cost across every stored run (uses the cheap run-summary cache in store.ts, 
 * each run's total was already computed once by runReimagine and cached in its
 * manifest, so this doesn't re-read every job's raw usage on every call).
 */
function spendToDate(options: store.ReadManifestOptions = {}): SpendToDateResult {
  const runs = store.listRuns(options);
  let totalCost = 0;
  let runCount = 0;
  let anyEstimatePricing = false;
  let anyUnpriced = false;
  for (const run of runs) {
    const cost = run.cost;
    if (!cost || !cost.jobCount) continue;
    runCount++;
    totalCost += cost.totalCost;
    if (cost.anyEstimatePricing) anyEstimatePricing = true;
    if (cost.anyUnpriced) anyUnpriced = true;
  }
  return { totalCost, currency: "USD", runCount, anyEstimatePricing, anyUnpriced, pricingLastUpdated: pricingLastUpdated() };
}

// Documented default assumption for the pre-run estimate when a model has no run
// history yet: a mid-size vision job, one screenshot + the system contract in,
// one full self-contained HTML document out. Deliberately conservative-but-real
// rather than zero, so a first-ever run still shows a meaningful "≈ $X".
const DEFAULT_AVG_TOKENS: NormalizedTokens = { inputTokens: 3000, outputTokens: 6000 };
const RECENT_RUNS_FOR_ESTIMATE = 20;

interface ModelAverageUsage extends NormalizedTokens {
  modelId: string;
  fromHistory: boolean; // false => DEFAULT_AVG_TOKENS fallback (no completed jobs yet for this model)
  sampleJobs: number;
}

/**
 * Average input/output tokens per completed ("ok") job for each requested model,
 * computed from the most recent stored runs. Falls back to DEFAULT_AVG_TOKENS
 * (flagged fromHistory:false) for a model with no usage history yet.
 */
function averageUsageByModel(modelIds: string[], options: store.ReadManifestOptions = {}): Record<string, ModelAverageUsage> {
  const wanted = new Set(modelIds);
  const sums = new Map<string, { inputTokens: number; outputTokens: number; count: number }>();
  const runs = store.listRuns(options).slice(0, RECENT_RUNS_FOR_ESTIMATE);

  for (const run of runs) {
    const manifest = store.readManifest(run.runId, options);
    if (!manifest || !Array.isArray(manifest.jobs)) continue;
    for (const job of manifest.jobs as unknown as RunCostJobLike[]) {
      if (!job || job.status !== "ok" || !job.usage || !wanted.has(job.modelId)) continue;
      const { inputTokens, outputTokens } = normalizeUsage(job.usage);
      const entry = sums.get(job.modelId) || { inputTokens: 0, outputTokens: 0, count: 0 };
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.count++;
      sums.set(job.modelId, entry);
    }
  }

  const out: Record<string, ModelAverageUsage> = {};
  for (const modelId of modelIds) {
    const entry = sums.get(modelId);
    if (entry && entry.count > 0) {
      out[modelId] = {
        modelId,
        inputTokens: entry.inputTokens / entry.count,
        outputTokens: entry.outputTokens / entry.count,
        fromHistory: true,
        sampleJobs: entry.count,
      };
    } else {
      out[modelId] = { modelId, ...DEFAULT_AVG_TOKENS, fromHistory: false, sampleJobs: 0 };
    }
  }
  return out;
}

interface EstimateRunInput {
  modelIds: string[];
  jobCount: number; // total jobs the pending run will submit (inputs × models × prompts × variants)
  jobCountByModel?: Record<string, number>; // if omitted, jobCount is split evenly across modelIds
}

interface EstimateRunResult {
  totalCost: number;
  currency: string;
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
  anyFromDefault: boolean; // true if any model used the documented default (no history yet)
  byModel: Record<string, { jobs: number; totalCost: number; fromHistory: boolean }>;
}

/**
 * Pre-run cost estimate: for each model, jobs-for-that-model × its average
 * historical usage (or the documented default) × pricing.json rate.
 */
function estimateRunCost(input: EstimateRunInput, options: store.ReadManifestOptions = {}): EstimateRunResult {
  const { modelIds, jobCount, jobCountByModel } = input;
  const averages = averageUsageByModel(modelIds, options);
  const byModel: EstimateRunResult["byModel"] = {};
  let totalCost = 0;
  let anyEstimatePricing = false;
  let anyUnpriced = false;
  let anyFromDefault = false;

  const evenSplit = modelIds.length ? jobCount / modelIds.length : 0;
  for (const modelId of modelIds) {
    const jobs = jobCountByModel?.[modelId] ?? evenSplit;
    const avg = averages[modelId] as ModelAverageUsage;
    const perJob = costForUsage(modelId, { input_tokens: avg.inputTokens, output_tokens: avg.outputTokens });
    const modelCost = perJob.totalCost * jobs;
    totalCost += modelCost;
    if (perJob.estimate) anyEstimatePricing = true;
    if (!perJob.priced) anyUnpriced = true;
    if (!avg.fromHistory) anyFromDefault = true;
    byModel[modelId] = { jobs, totalCost: modelCost, fromHistory: avg.fromHistory };
  }

  return { totalCost, currency: "USD", anyEstimatePricing, anyUnpriced, anyFromDefault, byModel };
}

export { normalizeUsage, costForUsage, runCost, spendToDate, averageUsageByModel, estimateRunCost, pricingLastUpdated, DEFAULT_AVG_TOKENS };
export type {
  NormalizedTokens,
  CostBreakdown,
  RunCostResult,
  RunCostJobLike,
  RunCostManifestLike,
  SpendToDateResult,
  ModelAverageUsage,
  EstimateRunInput,
  EstimateRunResult,
};

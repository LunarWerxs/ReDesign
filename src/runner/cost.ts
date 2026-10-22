// Run Cost Meter math: turns a provider's raw `usage` blob (three different
// shapes, Anthropic, OpenAI-compatible, Gemini, plus the mock stand-in) into
// normalized input/output token counts, then prices them against
// src/config/pricing.json. Additive-only: every helper here is read-only math,
// never mutates the manifest/job it's given.

import { priceForModel, pricingLastUpdated } from "../config/pricing";
import * as store from "../store";
import type { ProviderUsageEntry } from "../provider-call";

interface NormalizedTokens {
  inputTokens: number;
  outputTokens: number;
}

interface CostBreakdown extends NormalizedTokens {
  cacheTokens: number;
  modelId: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  estimate: boolean; // true if the model's price entry is a guess (pricing.json `estimate:true`)
  priced: boolean; // false if no pricing entry exists for this model (cost is 0, not "free")
  cacheAccountingPartial: boolean; // provider reported cache tokens but pricing has no cache rate
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * True for the mock adapter's usage blob ({ mock: true, ... }). Mock jobs emit a
 * tiny canned output (~1.5k tokens) with zero input and spend no real quota, so
 * they must never feed the historical average that drives the pre-run estimate
 * (see averageUsageByModel) - counting them drags a model's per-job token average
 * far below its real usage and makes the "≈ $X" estimate under-shoot badly.
 */
function isMockUsage(usage: unknown): boolean {
  return !!(usage && typeof usage === "object" && (usage as { mock?: unknown }).mock === true);
}

/**
 * Normalize any provider's `usage` object to { inputTokens, outputTokens }.
 * Recognizes:
 *   - Anthropic:        { input_tokens, output_tokens }
 *   - OpenAI-compatible: { prompt_tokens, completion_tokens }
 *   - Gemini:           { promptTokenCount, candidatesTokenCount, thoughtsTokenCount? }
 *   - mock adapter:     { mock: true, input_tokens, output_tokens }
 * Unrecognized/missing usage normalizes to zeros (cost math stays additive/safe).
 *
 * Reasoning tokens are billed as OUTPUT by every provider that charges for them, but they are
 * reported separately: Gemini puts thinking tokens in `thoughtsTokenCount` ALONGSIDE (not inside)
 * candidatesTokenCount, and OpenAI-compatible endpoints nest reasoning_tokens under
 * completion_tokens_details, where it is already included in completion_tokens. So Gemini's has to
 * be added and OpenAI's must NOT be, or the same tokens get billed twice.
 */
function normalizeUsage(usage: unknown): NormalizedTokens {
  if (!usage || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const u = usage as Record<string, unknown>;
  const inputTokens = num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  const outputTokens = num(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount) + num(u.thoughtsTokenCount);
  return { inputTokens, outputTokens };
}

function cacheTokenCount(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const details = u.prompt_tokens_details as Record<string, unknown> | null;
  return num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(details?.cached_tokens);
}

/**
 * Price one job's usage against the model's pricing.json entry.
 * priced=false (and totalCost=0) when the model has no pricing entry at all, 
 * distinct from a model that is priced but simply used zero tokens.
 */
function costForUsage(modelId: string, usage: unknown): CostBreakdown {
  const { inputTokens, outputTokens } = normalizeUsage(usage);
  const cacheTokens = cacheTokenCount(usage);
  const price = priceForModel(modelId);
  if (!price) {
    return { modelId, inputTokens, outputTokens, cacheTokens, inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD", estimate: false, priced: false, cacheAccountingPartial: cacheTokens > 0 };
  }
  const inputCost = (inputTokens / 1_000_000) * price.inputPerMtok;
  const outputCost = (outputTokens / 1_000_000) * price.outputPerMtok;
  return {
    modelId,
    inputTokens,
    outputTokens,
    cacheTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: price.currency || "USD",
    estimate: !!price.estimate,
    priced: true,
    cacheAccountingPartial: cacheTokens > 0,
  };
}

interface RunCostJobLike {
  modelId?: string;
  usage?: unknown;
  status?: string;
}

/** A raw provider-call ledger row.  Helpers and failed/empty replies belong here too. */
interface ProviderCallUsageLike {
  modelId: string;
  usage?: unknown;
  partial?: unknown;
  cost?: CostBreakdown | null;
}

interface RunCostManifestLike {
  jobs?: RunCostJobLike[];
  providerCalls?: unknown[];
}

interface RunCostResult {
  totalCost: number;
  currency: string;
  jobCount: number; // jobs that actually carried usage and contributed to totalCost
  anyEstimatePricing: boolean; // true if any contributing model's price is a guess
  anyUnpriced: boolean; // true if any job's model has no pricing.json entry
  anyPartialUsage?: boolean; // provider omitted usage; cost intentionally remains unknown
  anyCacheAccountingPartial?: boolean;
  byModel: Record<string, { totalCost: number; inputTokens: number; outputTokens: number }>;
}

type RunCostEntryLike = ProviderCallUsageLike | RunCostJobLike;

interface CostAccumulator {
  byModel: RunCostResult["byModel"];
  totalCost: number;
  jobCount: number;
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
  anyPartialUsage: boolean;
  anyCacheAccountingPartial: boolean;
}

/** Fold one ledger row (or one job row) into the running totals. */
function accumulateRunCost(acc: CostAccumulator, job: RunCostEntryLike, isLedger: boolean): void {
  if (!job?.modelId) return;
  if (!job?.usage || isMockUsage(job.usage)) {
    if (isLedger && (job as ProviderCallUsageLike).partial) acc.anyPartialUsage = true;
    return;
  }
  const breakdown = (isLedger ? (job as ProviderCallUsageLike).cost : null) ?? costForUsage(job.modelId, job.usage);
  acc.jobCount++;
  acc.totalCost += breakdown.totalCost;
  if (breakdown.estimate) acc.anyEstimatePricing = true;
  if (!breakdown.priced) acc.anyUnpriced = true;
  if (breakdown.cacheAccountingPartial) acc.anyCacheAccountingPartial = true;
  const entry = acc.byModel[job.modelId] || { totalCost: 0, inputTokens: 0, outputTokens: 0 };
  entry.totalCost += breakdown.totalCost;
  entry.inputTokens += breakdown.inputTokens;
  entry.outputTokens += breakdown.outputTokens;
  acc.byModel[job.modelId] = entry;
}

/** Sum cost across every job in a manifest that carries a `usage` blob. */
function runCost(manifest: RunCostManifestLike | null | undefined): RunCostResult {
  // New manifests carry a call ledger, which includes helper calls and billable
  // empty/error responses.  Do not also scan jobs or generation would double-count.
  const calls = Array.isArray(manifest?.providerCalls) ? manifest?.providerCalls as ProviderCallUsageLike[] : null;
  const jobs = calls || (Array.isArray(manifest?.jobs) ? manifest?.jobs : []);
  const acc: CostAccumulator = { byModel: {}, totalCost: 0, jobCount: 0, anyEstimatePricing: false, anyUnpriced: false, anyPartialUsage: false, anyCacheAccountingPartial: false };
  for (const job of jobs) accumulateRunCost(acc, job, !!calls);
  return { totalCost: acc.totalCost, currency: "USD", jobCount: acc.jobCount, anyEstimatePricing: acc.anyEstimatePricing, anyUnpriced: acc.anyUnpriced, anyPartialUsage: acc.anyPartialUsage, anyCacheAccountingPartial: acc.anyCacheAccountingPartial, byModel: acc.byModel };
}

/** Append one adapter outcome and recompute from the ledger only (never jobs). */
function recordProviderUsage(manifest: store.Manifest, entry: ProviderUsageEntry): RunCostResult {
  if (!Array.isArray(manifest.providerCalls)) manifest.providerCalls = [];
  const cost = entry.usage && !isMockUsage(entry.usage) ? costForUsage(entry.modelId, entry.usage) : null;
  manifest.providerCalls.push({ ...entry, cost });
  const total = runCost(manifest as unknown as RunCostManifestLike);
  manifest.cost = total;
  return total;
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
function spendToDate(options: store.ReadManifestOptions = {}, prefetchedRuns?: store.RunSummary[]): SpendToDateResult {
  // listRuns() readdirs OUTPUT_DIR and stats every run dir. /api/bootstrap already has that list
  // in hand, so it passes it in rather than making the app's hottest endpoint do the same walk
  // twice. Callers without one (the CLI, tests) keep the old behaviour.
  const runs = prefetchedRuns ?? store.listRuns(options);
  let totalCost = 0;
  let runCount = 0;
  let anyEstimatePricing = false;
  let anyUnpriced = false;
  for (const run of runs) {
    // Mock-mode runs spend no real quota, so they never count toward spend-to-date.
    // Guards both fresh mock runs (whose manifest cost is now 0, see runReimagine) and
    // any older mock manifests that still carry a baked-in placeholder cost on disk.
    if ((run as { mock?: boolean }).mock) continue;
    const cost = run.cost;
    if (!cost?.jobCount) continue;
    runCount++;
    totalCost += cost.totalCost;
    if (cost.anyEstimatePricing) anyEstimatePricing = true;
    if (cost.anyUnpriced) anyUnpriced = true;
  }
  return { totalCost, currency: "USD", runCount, anyEstimatePricing, anyUnpriced, pricingLastUpdated: pricingLastUpdated() };
}

let spendCache: { at: number; value: SpendToDateResult } | null = null;
/** A short-lived aggregate intentionally independent of the paged history endpoint. */
function cachedSpendToDate(options: store.ReadManifestOptions = {}): SpendToDateResult {
  if (spendCache && Date.now() - spendCache.at < 15_000) return spendCache.value;
  const value = spendToDate(options);
  spendCache = { at: Date.now(), value };
  return value;
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
  // Observed min/max output tokens across the sampled jobs, so the estimate can show a
  // spread (a dense screenshot emits far more HTML than a simple one). Equals the average
  // when there is no history (default fallback) or only a single sample.
  outputTokensLow: number;
  outputTokensHigh: number;
}

/**
 * Average input/output tokens per completed ("ok") job for each requested model,
 * computed from the most recent stored runs. Falls back to DEFAULT_AVG_TOKENS
 * (flagged fromHistory:false) for a model with no usage history yet.
 */
interface UsageSum {
  inputTokens: number;
  outputTokens: number;
  count: number;
  outputMin: number;
  outputMax: number;
}

/** Fold every completed, non-mock job of a wanted model from the most recent runs into `sums`. */
function accumulateUsage(sums: Map<string, UsageSum>, wanted: Set<string>, options: store.ReadManifestOptions): void {
  const runs = store.listRunsPage({ limit: RECENT_RUNS_FOR_ESTIMATE, options }).runs;
  for (const run of runs) {
    const manifest = store.readManifest(run.runId, options);
    if (!manifest || !Array.isArray(manifest.jobs)) continue;
    for (const job of manifest.jobs as unknown as RunCostJobLike[]) {
      if (job?.status !== "ok" || !job.modelId || !job.usage || isMockUsage(job.usage) || !wanted.has(job.modelId)) continue;
      const modelId = job.modelId;
      if (!modelId) continue;
      const { inputTokens, outputTokens } = normalizeUsage(job.usage);
      const entry = sums.get(modelId) || { inputTokens: 0, outputTokens: 0, count: 0, outputMin: Number.POSITIVE_INFINITY, outputMax: 0 };
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.outputMin = Math.min(entry.outputMin, outputTokens);
      entry.outputMax = Math.max(entry.outputMax, outputTokens);
      entry.count++;
      sums.set(modelId, entry);
    }
  }
}

/** Observed average, with the min/max output spread the estimate UI shows. */
function historyAverage(modelId: string, entry: UsageSum): ModelAverageUsage {
  const avgOut = entry.outputTokens / entry.count;
  return {
    modelId,
    inputTokens: entry.inputTokens / entry.count,
    outputTokens: avgOut,
    outputTokensLow: Number.isFinite(entry.outputMin) ? entry.outputMin : avgOut,
    outputTokensHigh: entry.outputMax || avgOut,
    fromHistory: true,
    sampleJobs: entry.count,
  };
}

function defaultAverage(modelId: string): ModelAverageUsage {
  return {
    modelId,
    ...DEFAULT_AVG_TOKENS,
    outputTokensLow: DEFAULT_AVG_TOKENS.outputTokens,
    outputTokensHigh: DEFAULT_AVG_TOKENS.outputTokens,
    fromHistory: false,
    sampleJobs: 0,
  };
}

function averageUsageByModel(modelIds: string[], options: store.ReadManifestOptions = {}): Record<string, ModelAverageUsage> {
  const wanted = new Set(modelIds);
  const sums = new Map<string, UsageSum>();
  accumulateUsage(sums, wanted, options);

  const out: Record<string, ModelAverageUsage> = {};
  for (const modelId of modelIds) {
    const entry = sums.get(modelId);
    out[modelId] = entry && entry.count > 0 ? historyAverage(modelId, entry) : defaultAverage(modelId);
  }
  return out;
}

interface EstimateRunInput {
  modelIds: string[];
  jobCount: number; // total jobs the pending run will submit (inputs × models × prompts × variants)
  jobCountByModel?: Record<string, number>; // if omitted, jobCount is split evenly across modelIds
}

interface EstimateRunResult {
  totalCost: number; // point estimate (per-model average usage)
  totalCostLow: number; // same run priced at each model's cheapest observed output
  totalCostHigh: number; // ...and its most expensive observed output
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
  let totalCostLow = 0;
  let totalCostHigh = 0;
  let anyEstimatePricing = false;
  let anyUnpriced = false;
  let anyFromDefault = false;

  const evenSplit = modelIds.length ? jobCount / modelIds.length : 0;
  for (const modelId of modelIds) {
    const jobs = jobCountByModel?.[modelId] ?? evenSplit;
    const avg = averages[modelId] as ModelAverageUsage;
    // Point estimate uses the average output; the low/high bounds hold input at the
    // average and swap in the cheapest/priciest output seen for this model, so the
    // spread reflects how much a run's HTML length swings with screenshot complexity.
    const perJob = costForUsage(modelId, { input_tokens: avg.inputTokens, output_tokens: avg.outputTokens });
    const perJobLow = costForUsage(modelId, { input_tokens: avg.inputTokens, output_tokens: avg.outputTokensLow });
    const perJobHigh = costForUsage(modelId, { input_tokens: avg.inputTokens, output_tokens: avg.outputTokensHigh });
    const modelCost = perJob.totalCost * jobs;
    totalCost += modelCost;
    totalCostLow += perJobLow.totalCost * jobs;
    totalCostHigh += perJobHigh.totalCost * jobs;
    if (perJob.estimate) anyEstimatePricing = true;
    if (!perJob.priced) anyUnpriced = true;
    if (!avg.fromHistory) anyFromDefault = true;
    byModel[modelId] = { jobs, totalCost: modelCost, fromHistory: avg.fromHistory };
  }

  return { totalCost, totalCostLow, totalCostHigh, currency: "USD", anyEstimatePricing, anyUnpriced, anyFromDefault, byModel };
}

// --- AI observability: per-generation traces --------------------------------------------------
// The Run Cost Meter above (runCost/spendToDate) only ever produced a TOTAL: one dollar figure per
// run or lifetime. Every fact a trace needs (latency, tokens, cost, error, which model) was already
// sitting on each job the whole time (job-worker.ts writes job.ms, job.usage and job.cost as it
// goes) - it was just never read back out as a list. This section is that read path: a normalized
// per-job "trace" record plus a cross-run, group-by-model rollup, adapted from PostHog's
// ai_observability product (per-generation trace: latency/tokens/cost, grouped by model).

interface TraceJobLike {
  id?: unknown;
  modelId: string;
  provider?: unknown;
  promptId?: unknown;
  status?: unknown;
  usage?: unknown;
  cost?: CostBreakdown | null;
  ms?: unknown;
  prepMs?: unknown;
  error?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}

interface TraceManifestLike {
  runId?: unknown;
  jobs?: TraceJobLike[];
  providerCalls?: Array<ProviderCallUsageLike & { provider?: unknown; purpose?: unknown; status?: unknown; error?: unknown; startedAt?: unknown; at?: unknown; ms?: unknown }>;
}

interface JobTrace {
  runId: string;
  jobId: string | null;
  modelId: string;
  provider: string | null;
  promptId: string | null;
  status: string;
  latencyMs: number | null; // job.ms: the model call itself, excludes prepMs (screenshot captioning)
  inputTokens: number;
  outputTokens: number;
  cost: number;
  currency: string;
  priced: boolean;
  error: string | null;
  purpose?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Flatten one manifest's jobs into normalized per-generation traces. Reuses each job's own
 * already-computed CostBreakdown (job.cost) when present rather than recomputing it, and falls
 * back to costForUsage for a manifest saved before job.cost existed on disk. A job with no usage
 * yet (still running/pending) still produces a trace row (status carries that instead), so a
 * live run's in-flight jobs show up rather than silently disappearing from the list.
 */
type TraceCallLike = NonNullable<TraceManifestLike["providerCalls"]>[number];

/** One trace row for a ledger call. Provider calls have no job identity, so those fields stay null. */
function callTrace(runId: string, call: TraceCallLike): JobTrace {
  const normalized = normalizeUsage(call.usage);
  const breakdown = call.cost ?? (call.usage && !isMockUsage(call.usage) ? costForUsage(call.modelId, call.usage) : null);
  return { runId, jobId: null, modelId: call.modelId, provider: str(call.provider), promptId: null, purpose: str(call.purpose), status: str(call.status) || "ok", latencyMs: typeof call.ms === "number" ? call.ms : null, inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens, cost: breakdown?.totalCost ?? 0, currency: breakdown?.currency || "USD", priced: breakdown?.priced ?? false, error: str(call.error), startedAt: str(call.startedAt), finishedAt: str(call.at) };
}

/** One trace row for a job, including one with no usage yet (status carries that instead). */
function jobTrace(runId: string, job: TraceJobLike): JobTrace {
  const { inputTokens, outputTokens } = normalizeUsage(job.usage);
  const breakdown = job.cost ?? (job.usage && !isMockUsage(job.usage) ? costForUsage(job.modelId, job.usage) : null);
  return { runId, jobId: str(job.id), modelId: job.modelId, provider: str(job.provider), promptId: str(job.promptId), status: str(job.status) || "unknown", latencyMs: typeof job.ms === "number" ? job.ms : null, inputTokens, outputTokens, cost: breakdown?.totalCost ?? 0, currency: breakdown?.currency || "USD", priced: breakdown?.priced ?? false, error: str(job.error), purpose: null, startedAt: str(job.startedAt), finishedAt: str(job.finishedAt) };
}

function runTraces(manifest: TraceManifestLike | null | undefined): JobTrace[] {
  const runId = str(manifest?.runId) || "";
  if (Array.isArray(manifest?.providerCalls)) return manifest.providerCalls.map((call) => callTrace(runId, call));
  const jobs = Array.isArray(manifest?.jobs) ? (manifest?.jobs as TraceJobLike[]) : [];
  const traces: JobTrace[] = [];
  for (const job of jobs) {
    if (!job || typeof job.modelId !== "string" || !job.modelId) continue;
    traces.push(jobTrace(runId, job));
  }
  return traces;
}

interface ModelTraceStats {
  modelId: string;
  calls: number; // traces with usage/cost data (terminal, non-mock)
  errors: number;
  avgLatencyMs: number | null;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Group a list of traces by model into the summary a "by model" table needs. */
function traceStatsByModel(traces: JobTrace[]): Record<string, ModelTraceStats> {
  const out: Record<string, ModelTraceStats> = {};
  const latencySum: Record<string, number> = {};
  const latencyCount: Record<string, number> = {};
  for (const trace of traces) {
    if (!out[trace.modelId]) {
      out[trace.modelId] = { modelId: trace.modelId, calls: 0, errors: 0, avgLatencyMs: null, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    }
    const entry = out[trace.modelId] as ModelTraceStats;
    if (trace.status === "error") entry.errors++;
    if (trace.status === "ok" || trace.status === "error") {
      entry.calls++;
      entry.totalCost += trace.cost;
      entry.totalInputTokens += trace.inputTokens;
      entry.totalOutputTokens += trace.outputTokens;
      if (trace.latencyMs != null) {
        latencySum[trace.modelId] = (latencySum[trace.modelId] || 0) + trace.latencyMs;
        latencyCount[trace.modelId] = (latencyCount[trace.modelId] || 0) + 1;
      }
    }
  }
  for (const modelId of Object.keys(out)) {
    const count = latencyCount[modelId];
    const entry = out[modelId];
    if (count && entry) entry.avgLatencyMs = (latencySum[modelId] || 0) / count;
  }
  return out;
}

const RECENT_RUNS_FOR_TRACES = 20;
const MAX_TRACES_RETURNED = 300;

interface RecentTracesResult {
  traces: JobTrace[]; // most recent first, capped at MAX_TRACES_RETURNED
  byModel: Record<string, ModelTraceStats>; // computed over every trace considered, not just the capped list
  runsConsidered: number;
}

/**
 * Per-generation traces across the most recent stored runs (default RECENT_RUNS_FOR_TRACES),
 * newest first, plus a by-model rollup. This is the list a Run Cost Meter can never show: which
 * specific calls were slow, which errored, and how that breaks down per model - not just a total.
 */
function recentTraces(options: store.ReadManifestOptions = {}, runLimit = RECENT_RUNS_FOR_TRACES): RecentTracesResult {
  const runs = store.listRunsPage({ limit: Math.max(1, runLimit), options }).runs;
  const all: JobTrace[] = [];
  for (const run of runs) {
    if ((run as { mock?: boolean }).mock) continue; // mock runs spend nothing real; keep them out of the trace list too
    const manifest = store.readManifest(run.runId, options);
    if (!manifest) continue;
    // store.Manifest's Job type is deliberately loose (a status plus an index signature, see
    // store/types.ts) since store.ts doesn't own the runner's richer job shape - same cast
    // averageUsageByModel above uses to read runner-written fields back off a stored manifest.
    all.push(...runTraces(manifest as unknown as TraceManifestLike));
  }
  // Newest first: finishedAt when the job is done, startedAt otherwise, so still-running jobs
  // (no finishedAt yet) sort by when they began rather than falling to the bottom.
  all.sort((a, b) => (b.finishedAt || b.startedAt || "").localeCompare(a.finishedAt || a.startedAt || ""));
  const byModel = traceStatsByModel(all);
  return { traces: all.slice(0, MAX_TRACES_RETURNED), byModel, runsConsidered: runs.length };
}

export { normalizeUsage, isMockUsage, costForUsage, runCost, recordProviderUsage, spendToDate, cachedSpendToDate, averageUsageByModel, estimateRunCost, pricingLastUpdated, DEFAULT_AVG_TOKENS, runTraces, traceStatsByModel, recentTraces };
export type {
  NormalizedTokens,
  CostBreakdown,
  RunCostResult,
  RunCostJobLike,
  RunCostManifestLike,
  ProviderCallUsageLike,
  SpendToDateResult,
  ModelAverageUsage,
  EstimateRunInput,
  EstimateRunResult,
  JobTrace,
  TraceJobLike,
  TraceManifestLike,
  ModelTraceStats,
  RecentTracesResult,
};

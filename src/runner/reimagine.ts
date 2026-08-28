// The main batch orchestrator: resolves inputs/models/prompts, builds the
// manifest, captions inputs/references for text-only models, runs every job
// through the pool scheduler, and persists progress/results as it goes.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, type SelectionInput } from "../util";
import type { KeyManager } from "../keyManager";
import { resolveModels, resolvePrompts, loadPrompts, loadModels } from "../config";
import { INPUT_DIR, listInputs, resolveSelection, loadImages, resolveReferences, loadReferenceImages, type InputItem, type LoadedImage } from "../inputResolver";
import { getAdapter } from "../providers";
import * as store from "../store";
import {
  getKeyManager,
  withKeyRotation,
  cfgInt,
  DESCRIBE_PROMPT,
  DESCRIBE_REF_PROMPT,
  SHORT_LABEL_PROMPT,
  cleanRunTitle,
  codename,
} from "./helpers";
import { buildJobs, buildPoolLimits, runJobsByPool, type Job } from "./scheduling";
import { runOneJob, type JobWorkerContext } from "./job-worker";
import type { Model } from "../config/models";

interface ReferenceOptions {
  enabled?: boolean;
  images?: unknown;
  rels?: unknown;
  ids?: unknown;
  note?: string;
}

interface RunReimagineOptions {
  keyManager?: KeyManager;
  mock?: boolean;
  variants?: number | string;
  modelQuantities?: Record<string, number | string>; // per-model copy count (overrides `variants` for that model)
  maxImagesPerInput?: number | string;
  concurrency?: number | string;
  poolConcurrency?: number | string;
  timeoutMs?: number;
  onProgress?: (event: Record<string, unknown>) => void;
  signal?: AbortSignal | null;
  inputs?: SelectionInput;
  models?: SelectionInput;
  prompts?: { presets?: unknown; custom?: string };
  reference?: ReferenceOptions | null;
  brandStyleGuide?: string | null;
  runId?: string;
  label?: string;
}

interface RunSummaryInfo {
  title: string;
  inputId: string;
  source: string;
  by?: string;
}

/**
 * Copy the run's first input screenshot into the run's own directory as `thumb.<ext>`, and
 * return that run-dir-relative name for the manifest.
 *
 * input/ is a scratch folder that gets emptied routinely, so a run summary that pointed the
 * viewer's gallery at the ORIGINAL input path showed a broken image for nearly every past run
 * (31 runs, 1 surviving input, when this was added on 2026-07-21). A per-run copy is a few
 * dozen KB and outlives the source. Best-effort: any failure just leaves the run without a
 * thumbnail, and the gallery falls back to the input path, then to a placeholder.
 */
function persistRunThumbnail(runId: string, inputItems: InputItem[]): string | null {
  const rel = inputItems[0]?.preview;
  if (!rel) return null;
  const src = path.join(INPUT_DIR, rel.split("/").join(path.sep));
  const name = `thumb${(path.extname(src) || ".png").toLowerCase()}`;
  try {
    const dir = store.runDir(runId);
    ensureDir(dir);
    fs.copyFileSync(src, path.join(dir, name));
    return name;
  } catch (_) {
    return null;
  }
}

// --- Vision helper selection --------------------------------------------------

function pickUsableVisionHelper(models: Model[], km: KeyManager, usable: (m: Model) => boolean): Model | null {
  const eligible = (m: Model) => m.vision !== false && usable(m);
  return (
    models.find(eligible) ||
    loadModels().find((m) => {
      if (m.enabled === false) return false;
      km.registerPool(m.keyEnv);
      return eligible(m);
    }) ||
    null
  );
}

// Pick a vision helper for short run labels and, when needed, captions for text-only models.
// Preference order is by LIVE keys, not configured ones: a pool whose keys are all
// revoked or out of balance still has a non-zero poolSize, and picking that helper
// meant every caption came back null. Fall back to configured-but-cooling only if
// nothing has a usable key right now, since a cooldown can lapse mid-run.
function resolveVisionHelper(models: Model[], km: KeyManager): Model | null {
  return (
    pickUsableVisionHelper(models, km, (m) => km.availableCount(m.keyEnv) > 0) ||
    pickUsableVisionHelper(models, km, (m) => km.poolSize(m.keyEnv) > 0)
  );
}

// --- Run summary (title) resolution --------------------------------------------

function buildFallbackRunSummary(mock: boolean, opts: RunReimagineOptions, input: InputItem, runId: string): RunSummaryInfo {
  if (mock && !opts.label) return { title: codename(runId), inputId: input.id, source: "mock" };
  const fallback = cleanRunTitle(opts.label || input.name || input.id) || input.id;
  return { title: fallback, inputId: input.id, source: opts.label ? "label" : "input" };
}

interface RunSummaryDescribeCtx {
  opts: RunReimagineOptions;
  mock: boolean;
  visionHelper: Model | null;
  km: KeyManager;
  timeoutMs: number;
  signal: AbortSignal | null;
  imagesFor: (input: InputItem) => LoadedImage[];
}

async function describeRunSummary(base: RunSummaryInfo, input: InputItem, ctx: RunSummaryDescribeCtx): Promise<RunSummaryInfo> {
  if (ctx.opts.label) return { ...base, source: "label" };
  if (ctx.mock) return base;
  if (!ctx.visionHelper) return { ...base, source: "input" };
  const helper = ctx.visionHelper;
  const r = await withKeyRotation(
    ctx.km,
    helper.keyEnv,
    ({ apiKey }) =>
      getAdapter(helper, { mock: false }).call({
        model: { ...helper, maxTokens: 48 },
        apiKey,
        systemContract: "You write concise UI inventory labels. Output only the label.",
        userPrompt: SHORT_LABEL_PROMPT,
        images: ctx.imagesFor(input),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        promptLabel: "run-label",
        inputName: input.name,
      }),
    { signal: ctx.signal },
  );
  const title = r ? cleanRunTitle(r.text) : "";
  return title ? { title, source: "ai", inputId: input.id, by: helper.id } : { ...base, source: "input" };
}

// --- Captioning (grounding) ------------------------------------------------------

interface CaptionCtx {
  mock: boolean;
  describer: Model | null;
  km: KeyManager;
  timeoutMs: number;
  signal: AbortSignal | null;
  imagesFor: (input: InputItem) => LoadedImage[];
}

async function captionInput(input: InputItem, ctx: CaptionCtx): Promise<string | null> {
  if (ctx.mock) return `[mock caption of ${input.name}]`;
  if (!ctx.describer) return null;
  const helper = ctx.describer;
  // Rotates through the helper's keys: a dead key here used to silently cost the
  // job its caption (text-only models then ran blind, grounded jobs ungrounded).
  const r = await withKeyRotation(
    ctx.km,
    helper.keyEnv,
    ({ apiKey }) =>
      getAdapter(helper, { mock: false }).call({
        model: { ...helper, maxTokens: 1500 },
        apiKey,
        systemContract: "You are a meticulous UI analyst. Output a thorough plain-text description only.",
        userPrompt: DESCRIBE_PROMPT,
        images: ctx.imagesFor(input),
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        promptLabel: "caption",
        inputName: input.name,
      }),
    { signal: ctx.signal },
  );
  return r ? r.text : null; // null → the job notes it ran without a caption
}

async function captionReference(referenceImages: LoadedImage[], ctx: CaptionCtx): Promise<string | null> {
  if (!referenceImages.length) return null;
  if (ctx.mock) return `[mock style caption of ${referenceImages.length} reference image(s)]`;
  if (!ctx.describer) return null;
  const helper = ctx.describer;
  const r = await withKeyRotation(
    ctx.km,
    helper.keyEnv,
    ({ apiKey }) =>
      getAdapter(helper, { mock: false }).call({
        model: { ...helper, maxTokens: 1200 },
        apiKey,
        systemContract: "You are a meticulous design analyst. Output a thorough plain-text description of visual style only.",
        userPrompt: DESCRIBE_REF_PROMPT,
        images: referenceImages,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        promptLabel: "ref-caption",
        inputName: "reference",
      }),
    { signal: ctx.signal },
  );
  return r ? r.text : null;
}

// --- Option / selection resolution --------------------------------------------

function resolveRunOptions(opts: RunReimagineOptions) {
  const km = opts.keyManager || getKeyManager();
  const mock = !!opts.mock;
  const variants = Math.max(1, Math.min(parseInt(String(opts.variants), 10) || 1, 10));
  // Per-model copy count (the web's per-model "quantity" control). Each entry
  // overrides the flat `variants` default for that one model; clamped 1..10.
  const variantsByModel: Record<string, number> = {};
  if (opts.modelQuantities && typeof opts.modelQuantities === "object") {
    for (const [id, q] of Object.entries(opts.modelQuantities)) {
      variantsByModel[id] = Math.max(1, Math.min(parseInt(String(q), 10) || 1, 10));
    }
  }
  // OPTIONAL image cap. Absent = uncapped, every input/reference image the caller selected is
  // sent (see inputResolver capImageRels). Only the CLI's --max-images and the MCP tool's
  // max_images still set one; the web UI's stepper was removed 2026-07-21 because a silent
  // default quietly dropped images the user had ticked.
  const reqImages = parseInt(String(opts.maxImagesPerInput ?? ""), 10);
  const maxImagesPerInput = Number.isFinite(reqImages) && reqImages > 0 ? reqImages : undefined;
  const concurrency = Math.max(1, parseInt(String(opts.concurrency), 10) || cfgInt("MAX_CONCURRENCY", 12));
  const poolConcurrency = Math.max(1, parseInt(String(opts.poolConcurrency), 10) || cfgInt("MAX_POOL_CONCURRENCY", 4));
  const timeoutMs = opts.timeoutMs || cfgInt("REQUEST_TIMEOUT_MS", 120000);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const signal = opts.signal || null;
  return { km, mock, variants, variantsByModel, maxImagesPerInput, concurrency, poolConcurrency, timeoutMs, onProgress, signal };
}

function resolveRunSelections(opts: RunReimagineOptions, maxImagesPerInput: number | undefined) {
  const allInputs = listInputs();
  const inputItems = resolveSelection(allInputs, opts.inputs);
  const models = resolveModels(opts.models);
  const prompts = resolvePrompts(opts.prompts || {});
  const { systemContract } = loadPrompts();

  // Resolve optional style reference images (global to the run, fed alongside
  // every input). `opts.reference` = { enabled?, images|rels|ids, note }.
  let referenceRels: string[] = [];
  let referenceNote = "";
  const ref = opts.reference;
  if (ref && ref.enabled !== false) {
    referenceRels = resolveReferences((ref.images ?? ref.rels ?? ref.ids ?? ref) as SelectionInput);
    referenceNote = String(ref?.note || "").trim();
  }
  const referenceImages: LoadedImage[] = referenceRels.length ? loadReferenceImages(referenceRels, { maxImages: maxImagesPerInput }) : [];

  if (!inputItems.length) throw new Error("No inputs matched the selection (input/ folder empty?).");
  if (!models.length) throw new Error("No models matched the selection.");
  if (!prompts.length) throw new Error("No prompts resolved.");

  return { inputItems, models, prompts, systemContract, referenceRels, referenceNote, referenceImages };
}

// --- Manifest construction -----------------------------------------------------

function buildRunManifest(
  runId: string,
  summary: RunSummaryInfo,
  jobs: Job[],
  thumb: string | null,
  ro: ReturnType<typeof resolveRunOptions>,
  rs: ReturnType<typeof resolveRunSelections>,
  poolLimits: ReturnType<typeof buildPoolLimits>,
  brandStyleGuide: string,
): store.Manifest {
  return {
    runId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    mock: ro.mock,
    summary,
    config: {
      inputIds: rs.inputItems.map((i) => i.id),
      modelIds: rs.models.map((m) => m.id),
      promptIds: rs.prompts.map((p) => p.id),
      variants: ro.variants,
      ...(Object.keys(ro.variantsByModel).length ? { variantsByModel: ro.variantsByModel } : {}),
      concurrency: ro.concurrency,
      poolConcurrency: ro.poolConcurrency,
      poolLimits: Object.fromEntries(poolLimits),
      maxImagesPerInput: ro.maxImagesPerInput,
      reference: rs.referenceImages.length
        ? { images: rs.referenceRels, count: rs.referenceImages.length, note: rs.referenceNote || null }
        : null,
      // Recorded so a run is fully reproducible from its own manifest: "Run again" and the
      // failed-job retry (http/routes/runs.ts) rebuild their submission out of config alone, and
      // without this the retried jobs would quietly drop the brand guide the originals were given.
      ...(brandStyleGuide ? { brandStyleGuide } : {}),
      // Always true now. Kept on the manifest so a run stays self-describing and so runs
      // recorded before 2026-07-28 (which carry `false`, or nothing at all) are still
      // distinguishable from current ones when comparing old output against new.
      grounded: true,
    },
    ...(thumb ? { thumb } : {}),
    inputs: rs.inputItems.map((i) => ({ id: i.id, name: i.name, type: i.type, imageCount: i.imageCount, preview: i.preview, images: i.images })),
    prompts: rs.prompts.map((p) => ({ id: p.id, label: p.label, source: p.source, user: p.user })),
    models: rs.models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, vision: m.vision, color: m.color })),
    counts: { total: jobs.length, done: 0, ok: 0, error: 0, skipped: 0 },
    // Running spend total for this run, updated as each job's usage lands. Additive
    // field, see src/runner/cost.ts for the per-job math (costForUsage/runCost).
    cost: { totalCost: 0, currency: "USD", jobCount: 0, anyEstimatePricing: false, anyUnpriced: false },
    jobs,
  };
}

// --- Post-schedule cleanup ------------------------------------------------------

// Any job the pool scheduler threw for (rather than resolving through its own ok/error
// path) never got its own status/finishedAt written; mark it as a failure so the
// manifest's counts and job list stay complete. Returns whether it touched anything,
// so the caller knows to mark the manifest dirty.
function applyScheduledResults<R extends { ok: boolean; job?: Job; error?: unknown }>(
  scheduledResults: R[],
  manifest: store.Manifest,
  onProgress: (event: Record<string, unknown>) => void,
): boolean {
  let dirty = false;
  for (const r of scheduledResults) {
    if (r.ok || !r.job || r.job.finishedAt) continue;
    r.job.status = "error";
    r.job.error = ((r.error as Error)?.message ? (r.error as Error).message : String(r.error || "failed")).slice(0, 300);
    r.job.ms = 0;
    r.job.finishedAt = new Date().toISOString();
    (manifest.counts as store.Counts).done++;
    (manifest.counts as store.Counts).error++;
    dirty = true;
    onProgress({ type: "job", runId: manifest.runId, job: r.job });
  }
  return dirty;
}

/**
 * Run a full reimagine batch. Returns the final manifest. Progress is streamed
 * via opts.onProgress(event) where event.type is start|job|done.
 */
async function runReimagine(opts: RunReimagineOptions = {}): Promise<store.Manifest> {
  const ro = resolveRunOptions(opts);
  const { km, mock, concurrency, poolConcurrency, timeoutMs, onProgress, signal, maxImagesPerInput } = ro;

  const rs = resolveRunSelections(opts, maxImagesPerInput);
  const { inputItems, models, prompts, systemContract, referenceRels, referenceImages } = rs;

  // Optional brand style guide: appended to every job's prompt (vision and text-only alike).
  const brandStyleGuide = String(opts.brandStyleGuide || "").trim();

  // Register key pools for the models we will use.
  for (const m of models) km.registerPool(m.keyEnv);

  // Cache base64 images per input so we read each file once, not per job.
  const imageCache = new Map<string, LoadedImage[]>();
  function imagesFor(input: InputItem): LoadedImage[] {
    if (!imageCache.has(input.id)) imageCache.set(input.id, loadImages(input, { maxImages: maxImagesPerInput }));
    return imageCache.get(input.id) as LoadedImage[];
  }

  const visionHelper = resolveVisionHelper(models, km);

  const runId = opts.runId || store.newRunId(opts.label);
  const jobs = buildJobs({ inputItems, models, prompts, variants: ro.variants, variantsByModel: ro.variantsByModel });
  const thumb = persistRunThumbnail(runId, inputItems);
  const summary = buildFallbackRunSummary(mock, opts, inputItems[0] as InputItem, runId);
  const poolLimits = buildPoolLimits(models, km, poolConcurrency);

  const manifest = buildRunManifest(runId, summary, jobs, thumb, ro, rs, poolLimits, brandStyleGuide);
  store.writeManifest(runId, manifest);
  onProgress({ type: "start", runId, total: jobs.length, manifest });
  const inputById = new Map(inputItems.map((i) => [i.id, i]));
  const modelById = new Map(models.map((m) => [m.id, m]));
  const promptById = new Map(prompts.map((p) => [p.id, p]));

  // Caption an input once (shared across all text-only jobs for that input).
  // Caches the PROMISE so concurrent jobs don't trigger duplicate caption calls.
  const captionCtx: CaptionCtx = { mock, describer: visionHelper, km, timeoutMs, signal, imagesFor };
  const descCache = new Map<string, Promise<string | null>>();
  function describeInput(input: InputItem): Promise<string | null> {
    const cached = descCache.get(input.id);
    if (cached) return cached;
    const p = captionInput(input, captionCtx);
    descCache.set(input.id, p);
    return p;
  }

  // Caption the style reference once (shared across all text-only jobs). Caches
  // the PROMISE so concurrent jobs don't trigger duplicate caption calls.
  let refCaptionPromise: Promise<string | null> | null = null;
  function describeReference(): Promise<string | null> {
    if (refCaptionPromise) return refCaptionPromise;
    refCaptionPromise = captionReference(referenceImages, captionCtx);
    return refCaptionPromise;
  }

  // Debounced manifest persistence as jobs complete.
  let manifestDirty = false;
  // A throw in here would be raised inside a setInterval callback, and src/index.ts installs no
  // uncaughtException handler, so a transient ENOSPC / EPERM / AV file lock would take the whole
  // daemon down and every other active and queued run with it. Swallow it and leave manifestDirty
  // set so the next tick retries; the run's own final write is what has to succeed.
  const flushManifest = () => {
    if (!manifestDirty) return;
    try {
      store.writeManifest(runId, manifest);
      manifestDirty = false;
    } catch (err) {
      console.warn(`[run ${runId}] manifest flush failed, will retry:`, err instanceof Error ? err.message : err);
    }
  };
  const flushTimer = setInterval(flushManifest, 750);
  if (flushTimer.unref) flushTimer.unref();

  const describeCtx: RunSummaryDescribeCtx = { opts, mock, visionHelper, km, timeoutMs, signal, imagesFor };
  const summaryPromise = describeRunSummary(summary, inputItems[0] as InputItem, describeCtx)
    .then((next) => {
      if (!next || (next.title === (manifest.summary as RunSummaryInfo).title && next.source === (manifest.summary as RunSummaryInfo).source)) return;
      manifest.summary = next;
      manifestDirty = true;
      store.writeManifest(runId, manifest);
      onProgress({ type: "snapshot", runId, manifest });
    })
    // Best-effort title/source enrichment, the run already has its default summary;
    // a failure here just means it keeps that default, so nothing needs to surface.
    .catch(() => {});

  // Pre-warm captions so the first jobs don't stall on them. Every job is grounded now, so
  // every input needs one, and firing all of them at once would put one concurrent vision
  // request per input against a single helper pool — a burst the job scheduler itself would
  // never allow (it caps each pool at poolConcurrency). Warm the same number the scheduler
  // would run, then let the rest be pulled in lazily: describeInput caches its promise, so a
  // job that arrives before its input is warmed simply starts the call itself and every
  // later job for that input shares it.
  for (const input of inputItems.slice(0, poolConcurrency)) describeInput(input);
  const anyTextOnly = models.some((m) => m.vision === false);
  if (anyTextOnly && referenceImages.length) describeReference();

  // Everything the per-job worker used to close over, assembled once. See runner/job-worker.ts:
  // the worker body moved there unchanged, so these field names are the originals.
  const jobContext: JobWorkerContext = {
    runId,
    manifest,
    mock,
    signal,
    timeoutMs,
    systemContract,
    brandStyleGuide,
    km,
    modelById,
    promptById,
    inputById,
    imagesFor,
    describeInput,
    describeReference,
    describer: visionHelper,
    referenceImages,
    referenceRels,
    referenceNote: rs.referenceNote,
    onProgress,
    markManifestDirty: () => {
      manifestDirty = true;
    },
  };

  const scheduledResults = await runJobsByPool<Job>(jobs, {
    totalConcurrency: concurrency,
    poolLimits,
    keyFor: (job) => (modelById.get(job.modelId) || ({} as Model)).keyEnv || "default",
    worker: (job) => runOneJob(job, jobContext),
  });
  if (applyScheduledResults(scheduledResults, manifest, onProgress)) manifestDirty = true;

  await summaryPromise;
  clearInterval(flushTimer);
  manifest.status = signal?.aborted ? "cancelled" : "done";
  manifest.finishedAt = new Date().toISOString();
  store.writeManifest(runId, manifest);
  km.save();
  onProgress({ type: "done", runId, manifest });
  return manifest;
}

export { runReimagine };
export type { RunReimagineOptions, ReferenceOptions, RunSummaryInfo };

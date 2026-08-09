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
 * Run a full reimagine batch. Returns the final manifest. Progress is streamed
 * via opts.onProgress(event) where event.type is start|job|done.
 */
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

async function runReimagine(opts: RunReimagineOptions = {}): Promise<store.Manifest> {
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

  // Resolve selections.
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

  // Optional brand style guide: appended to every job's prompt (vision and text-only alike).
  const brandStyleGuide = String(opts.brandStyleGuide || "").trim();

  if (!inputItems.length) throw new Error("No inputs matched the selection (input/ folder empty?).");
  if (!models.length) throw new Error("No models matched the selection.");
  if (!prompts.length) throw new Error("No prompts resolved.");

  // Register key pools for the models we will use.
  for (const m of models) km.registerPool(m.keyEnv);

  // Cache base64 images per input so we read each file once, not per job.
  const imageCache = new Map<string, LoadedImage[]>();
  function imagesFor(input: InputItem): LoadedImage[] {
    if (!imageCache.has(input.id)) imageCache.set(input.id, loadImages(input, { maxImages: maxImagesPerInput }));
    return imageCache.get(input.id) as LoadedImage[];
  }

  // Pick a vision helper for short run labels and, when needed, captions for
  // text-only models. Prefer one already selected for the run.
  //
  // Preference order is by LIVE keys, not configured ones: a pool whose keys are all
  // revoked or out of balance still has a non-zero poolSize, and picking that helper
  // meant every caption came back null. Fall back to configured-but-cooling only if
  // nothing has a usable key right now, since a cooldown can lapse mid-run.
  function pickVisionHelper(usable: (m: Model) => boolean): Model | null {
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
  const visionHelper: Model | null =
    pickVisionHelper((m) => km.availableCount(m.keyEnv) > 0) || pickVisionHelper((m) => km.poolSize(m.keyEnv) > 0);

  function fallbackRunSummary(): RunSummaryInfo {
    const input = inputItems[0] as InputItem;
    if (mock && !opts.label) return { title: codename(runId), inputId: input.id, source: "mock" };
    const fallback = cleanRunTitle(opts.label || input.name || input.id) || input.id;
    return { title: fallback, inputId: input.id, source: opts.label ? "label" : "input" };
  }

  async function describeRunSummary(base: RunSummaryInfo): Promise<RunSummaryInfo> {
    const input = inputItems[0] as InputItem;
    if (opts.label) return { ...base, source: "label" };
    if (mock) return base;
    if (!visionHelper) return { ...base, source: "input" };
    const helper = visionHelper;
    const r = await withKeyRotation(
      km,
      helper.keyEnv,
      ({ apiKey }) =>
        getAdapter(helper, { mock: false }).call({
          model: { ...helper, maxTokens: 48 },
          apiKey,
          systemContract: "You write concise UI inventory labels. Output only the label.",
          userPrompt: SHORT_LABEL_PROMPT,
          images: imagesFor(input),
          timeoutMs,
          signal,
          promptLabel: "run-label",
          inputName: input.name,
        }),
      { signal },
    );
    const title = r ? cleanRunTitle(r.text) : "";
    return title ? { title, source: "ai", inputId: input.id, by: helper.id } : { ...base, source: "input" };
  }

  // GROUNDING. A vision helper captions the screenshot once per input, and every job gets
  // that caption: a text-only model as its only view of the UI, a vision model as a
  // completeness checklist alongside the image it can already see. So every run is
  // grounded and there is no ungrounded path left.
  //
  // This used to be a per-run toggle defaulted OFF. It was measured head to head on
  // 2026-07-28 (2 screenshots x 5 vision models x 2 prompts x 2 variants = 39 paired
  // outputs, scored on the post-JS DOM — NOT the source, since several models build their
  // UI from a JS array — against the content actually visible in the original). Grounding
  // took 9 of the 20 model-and-prompt cells to 1, the rest tied: 100% content coverage vs
  // 86.8% on a dense picker panel, 95.2% vs 91.0% on a settings panel. Its one loss was a
  // model truncating at its token limit under BOTH conditions. Blind judging over the same
  // pairs put grounded ahead 24-15 overall and 21-5 on fidelity, with 17 dropped elements
  // against 51 and 44 fabrications against 87; ungrounded won on design flourish (23-13),
  // largely by inventing plausible-looking content. For a tool that reimagines YOUR screen,
  // a prototype that silently deletes a nav tab or invents metrics is the worse failure.
  // The entire cost is one shared caption call per input (~25s on a 20-job run; nothing
  // measurable against output-token spend), so there was nothing left for a setting to decide.
  const anyTextOnly = models.some((m) => m.vision === false);
  const describer = visionHelper;

  const runId = opts.runId || store.newRunId(opts.label);
  const jobs = buildJobs({ inputItems, models, prompts, variants, variantsByModel });
  const thumb = persistRunThumbnail(runId, inputItems);
  const summary = fallbackRunSummary();
  const poolLimits = buildPoolLimits(models, km, poolConcurrency);

  const manifest: store.Manifest = {
    runId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    mock,
    summary,
    config: {
      inputIds: inputItems.map((i) => i.id),
      modelIds: models.map((m) => m.id),
      promptIds: prompts.map((p) => p.id),
      variants,
      ...(Object.keys(variantsByModel).length ? { variantsByModel } : {}),
      concurrency,
      poolConcurrency,
      poolLimits: Object.fromEntries(poolLimits),
      maxImagesPerInput,
      reference: referenceImages.length ? { images: referenceRels, count: referenceImages.length, note: referenceNote || null } : null,
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
    inputs: inputItems.map((i) => ({ id: i.id, name: i.name, type: i.type, imageCount: i.imageCount, preview: i.preview, images: i.images })),
    prompts: prompts.map((p) => ({ id: p.id, label: p.label, source: p.source, user: p.user })),
    models: models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, vision: m.vision, color: m.color })),
    counts: { total: jobs.length, done: 0, ok: 0, error: 0, skipped: 0 },
    // Running spend total for this run, updated as each job's usage lands. Additive
    // field, see src/runner/cost.ts for the per-job math (costForUsage/runCost).
    cost: { totalCost: 0, currency: "USD", jobCount: 0, anyEstimatePricing: false, anyUnpriced: false },
    jobs,
  };
  store.writeManifest(runId, manifest);
  onProgress({ type: "start", runId, total: jobs.length, manifest });
  const inputById = new Map(inputItems.map((i) => [i.id, i]));
  const modelById = new Map(models.map((m) => [m.id, m]));
  const promptById = new Map(prompts.map((p) => [p.id, p]));

  // Caption an input once (shared across all text-only jobs for that input).
  // Caches the PROMISE so concurrent jobs don't trigger duplicate caption calls.
  const descCache = new Map<string, Promise<string | null>>();
  function describeInput(input: InputItem): Promise<string | null> {
    const cached = descCache.get(input.id);
    if (cached) return cached;
    const p = (async () => {
      if (mock) return `[mock caption of ${input.name}]`;
      if (!describer) return null;
      const helper = describer;
      // Rotates through the helper's keys: a dead key here used to silently cost the
      // job its caption (text-only models then ran blind, grounded jobs ungrounded).
      const r = await withKeyRotation(
        km,
        helper.keyEnv,
        ({ apiKey }) =>
          getAdapter(helper, { mock: false }).call({
            model: { ...helper, maxTokens: 1500 },
            apiKey,
            systemContract: "You are a meticulous UI analyst. Output a thorough plain-text description only.",
            userPrompt: DESCRIBE_PROMPT,
            images: imagesFor(input),
            timeoutMs,
            signal,
            promptLabel: "caption",
            inputName: input.name,
          }),
        { signal },
      );
      return r ? r.text : null; // null → the job notes it ran without a caption
    })();
    descCache.set(input.id, p);
    return p;
  }

  // Caption the style reference once (shared across all text-only jobs). Caches
  // the PROMISE so concurrent jobs don't trigger duplicate caption calls.
  let refCaptionPromise: Promise<string | null> | null = null;
  function describeReference(): Promise<string | null> {
    if (refCaptionPromise) return refCaptionPromise;
    refCaptionPromise = (async () => {
      if (!referenceImages.length) return null;
      if (mock) return `[mock style caption of ${referenceImages.length} reference image(s)]`;
      if (!describer) return null;
      const helper = describer;
      const r = await withKeyRotation(
        km,
        helper.keyEnv,
        ({ apiKey }) =>
          getAdapter(helper, { mock: false }).call({
            model: { ...helper, maxTokens: 1200 },
            apiKey,
            systemContract: "You are a meticulous design analyst. Output a thorough plain-text description of visual style only.",
            userPrompt: DESCRIBE_REF_PROMPT,
            images: referenceImages,
            timeoutMs,
            signal,
            promptLabel: "ref-caption",
            inputName: "reference",
          }),
        { signal },
      );
      return r ? r.text : null;
    })();
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

  const summaryPromise = describeRunSummary(summary)
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
    describer,
    referenceImages,
    referenceRels,
    referenceNote,
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
  for (const r of scheduledResults) {
    if (r.ok || !r.job || r.job.finishedAt) continue;
    r.job.status = "error";
    r.job.error = ((r.error as Error)?.message ? (r.error as Error).message : String(r.error || "failed")).slice(0, 300);
    r.job.ms = 0;
    r.job.finishedAt = new Date().toISOString();
    (manifest.counts as store.Counts).done++;
    (manifest.counts as store.Counts).error++;
    manifestDirty = true;
    onProgress({ type: "job", runId, job: r.job });
  }

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

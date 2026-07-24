// The main batch orchestrator: resolves inputs/models/prompts, builds the
// manifest, captions inputs/references for text-only models, runs every job
// through the pool scheduler, and persists progress/results as it goes.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJSON, type SelectionInput } from "../util";
import { CLASS, type KeyManager } from "../keyManager";
import { resolveModels, resolvePrompts, loadPrompts, loadModels } from "../config";
import { INPUT_DIR, listInputs, resolveSelection, loadImages, resolveReferences, loadReferenceImages, type InputItem, type LoadedImage } from "../inputResolver";
import { getAdapter, type ProviderError } from "../providers";
import { extractHtml } from "../extractHtml";
import * as store from "../store";
import {
  getKeyManager,
  cfgInt,
  DESCRIBE_PROMPT,
  DESCRIBE_REF_PROMPT,
  SHORT_LABEL_PROMPT,
  cleanRunTitle,
  codename,
  visionReferenceBlock,
  textReferenceBlock,
  brandStyleGuideBlock,
  groundingBlock,
} from "./helpers";
import { buildJobs, buildPoolLimits, runJobsByPool, type Job } from "./scheduling";
import { costForUsage, isMockUsage, type RunCostResult } from "./cost";
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
  /**
   * Feed VISION models a full written inventory of the screenshot alongside the image,
   * so they reimagine from a complete understanding instead of dropping/misreading
   * content in one pass. Reuses the caption already generated for text-only models
   * (one shared vision call per input); text-only models are grounded by definition.
   */
  groundWithDescription?: boolean;
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

  // Optional grounding: give vision models a full written inventory of the screenshot
  // (the same caption text-only models already get) so they don't drop/misread content.
  const grounding = !!opts.groundWithDescription;

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
  const visionHelper: Model | null =
    models.find((m) => m.vision !== false && km.poolSize(m.keyEnv) > 0) ||
    loadModels().find((m) => {
      if (m.vision === false || m.enabled === false) return false;
      km.registerPool(m.keyEnv);
      return km.poolSize(m.keyEnv) > 0;
    }) ||
    null;

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
    let acq: Awaited<ReturnType<KeyManager["acquireOrWait"]>> | null = null;
    try {
      acq = await km.acquireOrWait(visionHelper.keyEnv, 5000, signal);
      if (!acq.available) return { ...base, source: "input" };
      const r = await getAdapter(visionHelper, { mock: false }).call({
        model: { ...visionHelper, maxTokens: 48 },
        apiKey: acq.key as string,
        systemContract: "You write concise UI inventory labels. Output only the label.",
        userPrompt: SHORT_LABEL_PROMPT,
        images: imagesFor(input),
        timeoutMs,
        signal,
        promptLabel: "run-label",
        inputName: input.name,
      });
      km.report(visionHelper.keyEnv, acq.keyId as string, { errorClass: CLASS.OK });
      const title = cleanRunTitle(r.text);
      return title ? { title, source: "ai", inputId: input.id, by: visionHelper.id } : { ...base, source: "input" };
    } catch (err) {
      const provErr = err as ProviderError;
      if (acq?.available && provErr && provErr.name === "ProviderError") {
        km.report(visionHelper.keyEnv, acq.keyId as string, {
          errorClass: provErr.errorClass || CLASS.UNKNOWN,
          retryAfterMs: provErr.retryAfterMs || null,
          message: provErr.message,
        });
      }
      return { ...base, source: "input" };
    }
  }

  // A vision helper captions the screenshot when a text-only model needs it OR when
  // grounding is on (vision models then get the caption as a completeness checklist).
  const anyTextOnly = models.some((m) => m.vision === false);
  const describer = anyTextOnly || grounding ? visionHelper : null;

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
      grounded: grounding,
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
      try {
        const acq = await km.acquireOrWait(describer.keyEnv, 5000, signal);
        if (!acq.available) return null;
        const r = await getAdapter(describer, { mock: false }).call({
          model: { ...describer, maxTokens: 1500 },
          apiKey: acq.key as string,
          systemContract: "You are a meticulous UI analyst. Output a thorough plain-text description only.",
          userPrompt: DESCRIBE_PROMPT,
          images: imagesFor(input),
          timeoutMs,
          signal,
          promptLabel: "caption",
          inputName: input.name,
        });
        km.report(describer.keyEnv, acq.keyId as string, { errorClass: CLASS.OK });
        return r.text;
      } catch (_) {
        return null; // text-only model will note it ran without a caption
      }
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
      try {
        const acq = await km.acquireOrWait(describer.keyEnv, 5000, signal);
        if (!acq.available) return null;
        const r = await getAdapter(describer, { mock: false }).call({
          model: { ...describer, maxTokens: 1200 },
          apiKey: acq.key as string,
          systemContract: "You are a meticulous design analyst. Output a thorough plain-text description of visual style only.",
          userPrompt: DESCRIBE_REF_PROMPT,
          images: referenceImages,
          timeoutMs,
          signal,
          promptLabel: "ref-caption",
          inputName: "reference",
        });
        km.report(describer.keyEnv, acq.keyId as string, { errorClass: CLASS.OK });
        return r.text;
      } catch (_) {
        return null;
      }
    })();
    return refCaptionPromise;
  }

  // Debounced manifest persistence as jobs complete.
  let manifestDirty = false;
  const flushManifest = () => {
    if (!manifestDirty) return;
    store.writeManifest(runId, manifest);
    manifestDirty = false;
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

  // Pre-warm captions so the first job doesn't stall on them: needed for text-only
  // models and for grounding. The reference caption is text-only-only (vision models
  // see the reference image directly, so they never need it described).
  if (anyTextOnly || grounding) {
    for (const input of inputItems) describeInput(input);
  }
  if (anyTextOnly && referenceImages.length) describeReference();

  const scheduledResults = await runJobsByPool<Job>(jobs, {
    totalConcurrency: concurrency,
    poolLimits,
    keyFor: (job) => (modelById.get(job.modelId) || ({} as Model)).keyEnv || "default",
    worker: async (job) => {
      const model = modelById.get(job.modelId) as Model;
      const prompt = promptById.get(job.promptId) as ReturnType<typeof resolvePrompts>[number];
      const input = inputById.get(job.inputId) as InputItem;
      const hasVision = model.vision !== false; // default to vision-capable
      const t0 = Date.now();
      let lastErr: string | null = null;
      // Pre-flight (captioning) time, kept OUT of job.ms. A text-only model waits on
      // a vision model's caption before it can start, and charging that wait to the
      // model made it look far slower than it generates — the UI lists these numbers
      // side by side, so they have to measure the same thing.
      let prepMs = 0;

      if (signal?.aborted) {
        job.status = "cancelled";
      } else {
        const adapter = getAdapter(model, { mock });
        let images: LoadedImage[] = [];
        let effectivePrompt = prompt.user;
        let caption: string | null = null;
        let refCaption: string | null = null;
        // A text-only model must first caption the screenshot (a vision call that can
        // take several seconds). Flip the row to "running" with a note up front so the
        // UI shows motion during that pre-flight instead of a dead "pending".
        if (!hasVision) {
          job.status = "running";
          job.startedAt = new Date().toISOString();
          job.note = "preparing, describing the screenshot for this text-only model...";
          onProgress({ type: "job", runId, job });
        }
        if (hasVision) {
          images = imagesFor(input);
          if (!images.length) job.note = "no images loaded";
          // Optional grounding: a full written inventory of the screenshot rides along
          // with the image so the model reimagines every element instead of dropping or
          // inventing content. One shared caption per input (cached); its wait is charged
          // to prepMs, not to generation time, so grounded rows stay comparable.
          if (grounding) {
            const capStart = Date.now();
            caption = await describeInput(input);
            prepMs += Date.now() - capStart;
            if (caption) {
              effectivePrompt += groundingBlock(caption);
              if (!job.note) job.note = `grounded with a full description of the original${describer ? ` via ${describer.id}` : ""}`;
            }
          }
          // Style reference rides along at the END of the image list; the prompt
          // tells the model those trailing images are direction, not the product.
          if (referenceImages.length) {
            images = images.concat(referenceImages);
            effectivePrompt += visionReferenceBlock(referenceImages.length, referenceNote);
          }
        } else {
          // Text-only model (e.g. DeepSeek): feed it a vision-model caption of the
          // screenshot so it reimagines the real UI rather than a generic one.
          caption = await describeInput(input);
          if (caption) {
            effectivePrompt = `${prompt.user}\n\n--- You cannot see the image. A detailed description of the interface to reimagine follows: ---\n${caption}`;
            job.note = `text-only model, fed an auto caption${describer ? ` via ${describer.id}` : ""}`;
          } else {
            job.note = "text-only model, no caption available, ran without seeing the UI";
          }
          // A text-only model also can't see the reference, feed it a description.
          if (referenceImages.length) {
            refCaption = await describeReference();
            if (refCaption) effectivePrompt += textReferenceBlock(refCaption, referenceNote);
          }
          prepMs = Date.now() - t0;
        }
        if (brandStyleGuide) effectivePrompt += brandStyleGuideBlock(brandStyleGuide);
        job.status = "running";
        job.startedAt = new Date().toISOString();
        onProgress({ type: "job", runId, job });

        const poolSize = km.poolSize(model.keyEnv);
        const maxAttempts = Math.max(1, Math.min(poolSize || 1, 6));

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (signal?.aborted) {
            job.status = "cancelled";
            break;
          }
          const acq = await km.acquireOrWait(model.keyEnv, 5000, signal);
          if (!acq.available) {
            if (acq.reason === "aborted") {
              job.status = "cancelled";
            } else {
              // Not the job's fault, no usable key right now. Mark skipped so the
              // run summary distinguishes infra exhaustion from model errors.
              lastErr = acq.reason === "no_keys" ? `no API keys configured for ${model.keyEnv}` : `all keys cooling down (${model.keyEnv})`;
              job.status = "skipped";
              job.error = lastErr;
            }
            break;
          }
          job.attempts = attempt;
          job.keyMask = acq.mask as string;
          try {
            const result = await adapter.call({
              model,
              apiKey: acq.key as string,
              systemContract,
              userPrompt: effectivePrompt,
              images,
              timeoutMs,
              signal,
              promptLabel: prompt.label,
              inputName: input.name,
            });
            // A mock success proves nothing about the real key, so don't record it
            // as validated health (a default mock run leaves key state untouched).
            if (!mock) km.report(model.keyEnv, acq.keyId as string, { errorClass: CLASS.OK });

            const { html, wrapped } = extractHtml(result.text);
            const rel = path.join(job.inputId, `${model.id}__${prompt.id}__v${job.variant}.html`);
            const abs = path.join(store.runDir(runId), rel);
            ensureDir(path.dirname(abs));
            fs.writeFileSync(abs, html);
            writeJSON(abs.replace(/\.html$/, ".meta.json"), {
              job: job.id,
              model: model.id,
              prompt: prompt.id,
              promptText: prompt.user,
              input: input.name,
              keyMask: acq.mask,
              usage: result.usage || null,
              finishReason: result.finishReason || null,
              wrapped,
              rawChars: result.text.length,
              caption: caption || null,
              captionBy: caption ? describer?.id || null : null,
              reference: referenceImages.length
                ? { images: referenceRels, note: referenceNote || null, caption: refCaption || null, captionBy: refCaption ? describer?.id || null : null }
                : null,
              createdAt: new Date().toISOString(),
            });

            job.status = "ok";
            job.file = path.join(runId, rel).split(path.sep).join("/");
            job.usage = result.usage || null;
            // Mock-mode jobs spend no real quota, so they never carry a cost (keeps the
            // run's cost meter and spend-to-date honest, see cost.ts isMockUsage).
            job.cost = job.usage && !isMockUsage(job.usage) ? costForUsage(model.id, job.usage) : null;
            if (job.cost) {
              const rc = manifest.cost as RunCostResult;
              rc.totalCost += job.cost.totalCost;
              rc.jobCount++;
              if (job.cost.estimate) rc.anyEstimatePricing = true;
              if (!job.cost.priced) rc.anyUnpriced = true;
            }
            job.wrapped = wrapped;
            job.finishReason = result.finishReason || null;
            // Normalize each provider's distinct truncation signal:
            // Anthropic 'max_tokens' · OpenAI/DeepSeek/Qwen 'length' · Gemini 'MAX_TOKENS'.
            const fr = String(result.finishReason || "").toLowerCase();
            job.truncated = fr === "max_tokens" || fr === "length" || fr === "model_length";
            if (job.truncated) job.note = "output truncated at token limit, raise maxTokens in models.json";
            job.error = null;
            lastErr = null;
            break;
          } catch (err) {
            // A cancelled in-flight request isn't a key failure, don't cool the key.
            if (signal?.aborted) {
              job.status = "cancelled";
              break;
            }
            const provErr = err as ProviderError;
            const isProvider = provErr && provErr.name === "ProviderError";
            const errorClass = isProvider ? provErr.errorClass : CLASS.UNKNOWN;
            km.report(model.keyEnv, acq.keyId as string, {
              errorClass: isProvider ? errorClass : CLASS.BAD_REQUEST, // don't blame key for our bug
              retryAfterMs: isProvider ? provErr.retryAfterMs : null,
              message: provErr.message,
            });
            lastErr = provErr.message;
            const retryable = isProvider ? provErr.retryable : false;
            if (!retryable) {
              job.status = "error";
              break;
            }
            // else loop to next key
          }
        }

        if (job.status !== "ok" && job.status !== "cancelled" && job.status !== "skipped") {
          job.status = "error";
          job.error = lastErr || "failed";
        }
      }

      job.ms = Math.max(0, Date.now() - t0 - prepMs);
      if (prepMs) job.prepMs = prepMs;
      job.finishedAt = new Date().toISOString();

      // Exactly-once accounting for every job, including pre-flight cancellation.
      (manifest.counts as store.Counts).done++;
      if (job.status === "ok") (manifest.counts as store.Counts).ok++;
      else if (job.status === "cancelled" || job.status === "skipped") (manifest.counts as store.Counts).skipped++;
      else (manifest.counts as store.Counts).error++;
      manifestDirty = true;
      onProgress({ type: "job", runId, job });
    },
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

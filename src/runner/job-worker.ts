/**
 * One job of a run: pick a key, call the model, save what comes back, and account for it.
 *
 * Lifted out of runReimagine's inline `worker:` closure, which had grown to ~225 lines inside an
 * already 500-line function and closed over two dozen outer bindings, so none of it could be
 * exercised without standing up a whole batch. The body is UNCHANGED by the move: every binding it
 * used is now a field on JobWorkerContext, destructured below under its original name, so the code
 * below reads exactly as it did in place.
 *
 * The one thing that could not travel as a plain value is runReimagine's mutable `manifestDirty`
 * flag, which the worker sets to schedule a manifest flush. It is passed as markManifestDirty().
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJSON } from "../util";
import { CLASS, type KeyManager } from "../keyManager";
import type { resolvePrompts } from "../config";
import type { InputItem, LoadedImage } from "../inputResolver";
import { getAdapter, type ProviderError } from "../providers";
import { extractHtml } from "../extractHtml";
import { injectOutputHeightMeasure } from "../outputMeasure";
import * as store from "../store";
import { groundingBlock, visionReferenceBlock, textReferenceBlock, brandStyleGuideBlock } from "./helpers";
import { costForUsage, isMockUsage, type RunCostResult } from "./cost";
import type { Job } from "./scheduling";
import type { Model } from "../config/models";

type ResolvedPrompt = ReturnType<typeof resolvePrompts>[number];

/** Everything the moved body used to close over. Field names match the originals exactly. */
export interface JobWorkerContext {
  runId: string;
  manifest: store.Manifest;
  mock: boolean;
  signal: AbortSignal | null | undefined;
  timeoutMs: number;
  systemContract: string;
  brandStyleGuide: string;
  km: KeyManager;
  modelById: Map<string, Model>;
  promptById: Map<string, ResolvedPrompt>;
  inputById: Map<string, InputItem>;
  imagesFor: (input: InputItem) => LoadedImage[];
  describeInput: (input: InputItem) => Promise<string | null>;
  describeReference: () => Promise<string | null>;
  describer: Model | null | undefined;
  referenceImages: LoadedImage[];
  referenceRels: string[];
  referenceNote: string;
  onProgress: (event: Record<string, unknown>) => void;
  markManifestDirty: () => void;
}

export async function runOneJob(job: Job, ctx: JobWorkerContext): Promise<void> {
  const {
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
    markManifestDirty,
  } = ctx;
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
      // Grounding: a full written inventory of the screenshot rides along with the
      // image so the model reimagines every element instead of dropping or inventing
      // content. One shared caption per input (cached); its wait is charged to prepMs,
      // not to generation time, so a job's reported speed stays comparable to a
      // text-only model's, which pays the same wait.
      const capStart = Date.now();
      caption = await describeInput(input);
      prepMs += Date.now() - capStart;
      if (caption) {
        effectivePrompt += groundingBlock(caption);
        if (!job.note) job.note = `grounded with a full description of the original${describer ? ` via ${describer.id}` : ""}`;
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

    // One attempt per key in the pool (bounded by MAX_KEY_ATTEMPTS). acquire()
    // already skips keys in cooldown, so a healthy pool never spends more than one
    // attempt; only a pool full of dead/exhausted keys works through the budget.
    const maxAttempts = km.attemptBudget(model.keyEnv);

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

        // Record what the provider has ALREADY billed before touching the disk. Everything
        // below this point can fail locally, and when it does the call still happened and
        // still cost money, so the run's cost meter and spend-to-date have to reflect it.
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

        const rel = path.join(job.inputId, `${model.id}__${prompt.id}__v${job.variant}.html`);
        const abs = path.join(store.runDir(runId), rel);
        let wrapped: boolean;
        try {
          const extracted = extractHtml(result.text);
          wrapped = extracted.wrapped;
          ensureDir(path.dirname(abs));
          // Embed the viewer's height-measurement script now, so /output-raw/* can stream the
          // file straight off disk instead of reading and rewriting it on every gallery card.
          // Inert outside the viewer's iframe, so a downloaded output still stands alone.
          //
          // Async: a self-contained redesign is the largest thing this run writes, and with
          // MAX_CONCURRENCY jobs finishing in a cluster a synchronous write chain would block
          // Bun's single thread back-to-back, stalling SSE progress for every other run.
          await fs.promises.writeFile(abs, injectOutputHeightMeasure(extracted.html));
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
        } catch (writeErr) {
          // The model answered and the key worked, only OUR side failed (disk full, AV lock,
          // unparseable payload). Reporting the key here would bench a healthy key, and
          // retrying with the next one would pay a second time for the same output, so do
          // neither: fail this job with a message that names the real cause and stop.
          lastErr = `output could not be saved: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
          job.status = "error";
          job.error = lastErr.slice(0, 300);
          break;
        }

        job.status = "ok";
        job.file = path.join(runId, rel).split(path.sep).join("/");
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
  markManifestDirty();
  onProgress({ type: "job", runId, job });
}

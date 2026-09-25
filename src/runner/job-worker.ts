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
import type { resolvePrompts } from "../config";
import type { Model } from "../config/models";
import { extractHtml } from "../extractHtml";
import type { InputItem, LoadedImage } from "../inputResolver";
import { CLASS, type KeyManager } from "../keyManager";
import { injectOutputHeightMeasure } from "../outputMeasure";
import { getAdapter, type ProviderError } from "../providers";
import * as store from "../store";
import { ensureDir, writeJSON } from "../util";
import { type CostBreakdown, costForUsage, isMockUsage, type RunCostResult } from "./cost";
import { brandStyleGuideBlock, groundingBlock, textReferenceBlock, visionReferenceBlock } from "./helpers";
import type { Job } from "./scheduling";
import { lintHtml, slopFixBlock, slopRetryEnabled, summarizeSlop } from "./slop-lint";

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

interface PromptBuild {
  effectivePrompt: string;
  images: LoadedImage[];
  caption: string | null;
  refCaption: string | null;
  prepMs: number;
  /** Appended to the output filename; the anti-slop retry writes beside the first answer, not over it. */
  fileSuffix?: string;
}

// The vision-vs-text-only preflight: builds the prompt/image payload and captions the
// screenshot (and, for a text-only model, the reference) before the first call goes out.
// Pulled out of runOneJob so this branching scores against this small function instead of
// the job loop's — see this file's header for why the body itself is otherwise unchanged.
// The two branches live in the sibling helpers below, so this stays a dispatcher.
async function buildJobPrompt(ctx: JobWorkerContext, job: Job, prompt: ResolvedPrompt, input: InputItem, hasVision: boolean, t0: number): Promise<PromptBuild> {
  const built = hasVision
    ? await prepareVisionPrompt(ctx, job, prompt, input)
    : await prepareTextOnlyPrompt(ctx, job, prompt, input, t0);
  if (ctx.brandStyleGuide) built.effectivePrompt += brandStyleGuideBlock(ctx.brandStyleGuide);
  return built;
}

// Vision-capable model: the screenshot (plus any style reference) rides along with the
// prompt, and its caption is one shared, cached description per input.
async function prepareVisionPrompt(ctx: JobWorkerContext, job: Job, prompt: ResolvedPrompt, input: InputItem): Promise<PromptBuild> {
  const { describer, referenceImages, referenceNote, imagesFor, describeInput } = ctx;
  let images = imagesFor(input);
  if (!images.length) job.note = "no images loaded";
  // Grounding: a full written inventory of the screenshot rides along with the
  // image so the model reimagines every element instead of dropping or inventing
  // content. One shared caption per input (cached); its wait is charged to prepMs,
  // not to generation time, so a job's reported speed stays comparable to a
  // text-only model's, which pays the same wait.
  const capStart = Date.now();
  const caption = await describeInput(input);
  const prepMs = Date.now() - capStart;
  let effectivePrompt = prompt.user;
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
  return { effectivePrompt, images, caption, refCaption: null, prepMs };
}

// Text-only model (e.g. DeepSeek): feed it a vision-model caption of the screenshot so it
// reimagines the real UI rather than a generic one, and a description for the reference.
async function prepareTextOnlyPrompt(ctx: JobWorkerContext, job: Job, prompt: ResolvedPrompt, input: InputItem, t0: number): Promise<PromptBuild> {
  const { runId, describer, referenceImages, referenceNote, describeInput, describeReference, onProgress } = ctx;

  // A text-only model must first caption the screenshot (a vision call that can
  // take several seconds). Flip the row to "running" with a note up front so the
  // UI shows motion during that pre-flight instead of a dead "pending".
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.note = "preparing, describing the screenshot for this text-only model...";
  onProgress({ type: "job", runId, job });

  const caption = await describeInput(input);
  let effectivePrompt = prompt.user;
  if (caption) {
    effectivePrompt = `${prompt.user}\n\n--- You cannot see the image. A detailed description of the interface to reimagine follows: ---\n${caption}`;
    job.note = `text-only model, fed an auto caption${describer ? ` via ${describer.id}` : ""}`;
  } else {
    job.note = "text-only model, no caption available, ran without seeing the UI";
  }
  // A text-only model also can't see the reference, feed it a description.
  let refCaption: string | null = null;
  if (referenceImages.length) {
    refCaption = await describeReference();
    if (refCaption) effectivePrompt += textReferenceBlock(refCaption, referenceNote);
  }
  return { effectivePrompt, images: [], caption, refCaption, prepMs: Date.now() - t0 };
}

type AdapterCallResult = Awaited<ReturnType<ReturnType<typeof getAdapter>["call"]>>;

// What one successful call was billed, recorded BEFORE anything touches the disk.
function recordJobUsageAndCost(manifest: store.Manifest, job: Job, model: Model, result: AdapterCallResult): void {
  // Record what the provider has ALREADY billed before touching the disk. Everything
  // below this point can fail locally, and when it does the call still happened and
  // still cost money, so the run's cost meter and spend-to-date have to reflect it.
  job.usage = result.usage || null;
  // Mock-mode jobs spend no real quota, so they never carry a cost (keeps the
  // run's cost meter and spend-to-date honest, see cost.ts isMockUsage).
  job.cost = job.usage && !isMockUsage(job.usage) ? costForUsage(model.id, job.usage) : null;
  // A run wrapped in withProviderRun records this call before we reach the
  // filesystem. Its ledger includes helpers and empty billed replies, so adding
  // the generation here would double-count it. Legacy/direct worker fixtures
  // keep the previous per-job aggregate.
  if (job.cost && !Array.isArray(manifest.providerCalls)) {
    const rc = manifest.cost as RunCostResult;
    rc.totalCost += job.cost.totalCost;
    rc.jobCount++;
    if (job.cost.estimate) rc.anyEstimatePricing = true;
    if (!job.cost.priced) rc.anyUnpriced = true;
  }
}

// Writes the output plus its sidecar .meta.json. A write failure (disk full, AV lock,
// unparseable payload — none of them the key's fault) comes back as `ok: false` rather
// than a throw, so it scores against this function alone.
async function saveJobOutput(
  ctx: JobWorkerContext,
  job: Job,
  model: Model,
  prompt: ResolvedPrompt,
  input: InputItem,
  result: AdapterCallResult,
  built: PromptBuild,
  keyMask: string,
): Promise<{ ok: true; extracted: ReturnType<typeof extractHtml>; rel: string } | { ok: false; error: string }> {
  const { runId, referenceImages, referenceRels, referenceNote, describer } = ctx;
  const { caption, refCaption } = built;
  const rel = path.join(job.inputId, `${model.id}__${prompt.id}__v${job.variant}${built.fileSuffix || ""}.html`);
  const abs = path.join(store.runDir(runId), rel);
  try {
    const extracted = extractHtml(result.text);
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
      keyMask,
      usage: result.usage || null,
      finishReason: result.finishReason || null,
      wrapped: extracted.wrapped,
      extraction: extracted.outcome,
      rawChars: result.text.length,
      caption: caption || null,
      captionBy: caption ? describer?.id || null : null,
      reference: referenceImages.length
        ? { images: referenceRels, note: referenceNote || null, caption: refCaption || null, captionBy: refCaption ? describer?.id || null : null }
        : null,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, extracted, rel };
  } catch (writeErr) {
    // The model answered and the key worked, only OUR side failed. Reporting the key
    // here would bench a healthy key, and retrying with the next one would pay a second
    // time for the same output, so do neither: name the real cause and stop.
    return { ok: false, error: `output could not be saved: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}` };
  }
}

// The post-write half: file bookkeeping, the truncation signal, and whether the payload
// that was saved actually counts as a redesign.
function applyOutputOutcome(job: Job, runId: string, rel: string, extracted: ReturnType<typeof extractHtml>, result: AdapterCallResult): { ok: true } | { ok: false; error: string } {
  job.file = path.join(runId, rel).split(path.sep).join("/");
  job.wrapped = extracted.wrapped;
  job.finishReason = result.finishReason || null;
  // Normalize each provider's distinct truncation signal:
  // Anthropic 'max_tokens' · OpenAI/DeepSeek/Qwen 'length' · Gemini 'MAX_TOKENS'.
  const fr = String(result.finishReason || "").toLowerCase();
  job.truncated = fr === "max_tokens" || fr === "length" || fr === "model_length";
  if (job.truncated) job.note = "output truncated at token limit, raise maxTokens in models.json";
  if (extracted.outcome === "non-html") {
    // The provider may have billed this response, and the diagnostic artifact above is useful
    // for inspection, but a refusal/prose response is not a redesign. Stop here rather than
    // rotating to another key (which would automatically pay again); the normal failed-job retry
    // action can make a deliberate new attempt.
    const error = "model returned no HTML output";
    job.status = "error";
    job.error = error;
    return { ok: false, error };
  }

  job.status = "ok";
  job.error = null;
  return { ok: true };
}

// Records provider usage/cost and writes the output + its sidecar .meta.json for one
// successful call. Pulled out of the attempt loop so a write failure (disk full, AV lock,
// unparseable payload — none of them the key's fault) scores against this function alone.
// The cost ledger, the disk write and the outcome classification are the siblings above.
async function finalizeJobResult(
  ctx: JobWorkerContext,
  job: Job,
  model: Model,
  prompt: ResolvedPrompt,
  input: InputItem,
  result: AdapterCallResult,
  built: PromptBuild,
  keyMask: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  recordJobUsageAndCost(ctx.manifest, job, model, result);
  const saved = await saveJobOutput(ctx, job, model, prompt, input, result, built, keyMask);
  if (!saved.ok) return { ok: false, error: saved.error };
  const outcome = applyOutputOutcome(job, ctx.runId, saved.rel, saved.extracted, result);
  // Free, local anti-slop score of the saved redesign (see slop-lint.ts); the gallery badges it
  // and runOneJob spends one retry on a P0. The caption lets it tell real figures from invented ones.
  if (outcome.ok) job.slop = summarizeSlop(lintHtml(saved.extracted.html, { sourceText: built.caption }));
  return outcome;
}

// Adds a second call's cost onto the first, so a retried job's cost shows everything it spent.
function sumCost(a: CostBreakdown | null | undefined, b: CostBreakdown | null | undefined): CostBreakdown | null {
  if (!a || !b) return a || b || null;
  return {
    ...a,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheTokens: a.cacheTokens + b.cacheTokens,
    inputCost: a.inputCost + b.inputCost,
    outputCost: a.outputCost + b.outputCost,
    totalCost: a.totalCost + b.totalCost,
    estimate: a.estimate || b.estimate,
    priced: a.priced && b.priced,
    cacheAccountingPartial: a.cacheAccountingPartial || b.cacheAccountingPartial,
  };
}

// One re-prompt for an output the anti-slop lint scored P0: the findings ride along as a fix list.
// The retry writes a sibling file and is KEPT only when it ends ok with fewer P0 findings; any
// other outcome (worse, failed, cancelled, spend ceiling hit) restores the first answer as it was.
// Either way the job's cost includes the retry, because the provider billed it.
async function retrySloppyOutput(
  ctx: JobWorkerContext,
  job: Job,
  model: Model,
  prompt: ResolvedPrompt,
  input: InputItem,
  adapter: ReturnType<typeof getAdapter>,
  built: PromptBuild,
  maxAttempts: number,
): Promise<void> {
  const first = job.slop;
  if (!first || first.p0 === 0 || !slopRetryEnabled() || ctx.signal?.aborted) return;
  const before = { ...job };
  job.note = `anti-slop retry: ${first.findings.filter((f) => f.severity === "P0").map((f) => f.rule).join(", ")}`;
  ctx.onProgress({ type: "job", runId: ctx.runId, job });

  const retryBuilt: PromptBuild = { ...built, effectivePrompt: built.effectivePrompt + slopFixBlock(first.findings), fileSuffix: "__slopfix" };
  await runJobAttempts(ctx, job, model, prompt, input, adapter, retryBuilt, maxAttempts);

  const retryCost = job.cost !== before.cost ? job.cost : null;
  const after = job.status === "ok" ? job.slop : null;
  const kept = !!after && after.p0 < first.p0;
  if (!kept) {
    for (const key of Object.keys(job)) if (!(key in before)) Reflect.deleteProperty(job, key);
    Object.assign(job, before);
  }
  job.cost = sumCost(before.cost, retryCost);
  job.slopRetry = { kept, before: { p0: first.p0, p1: first.p1, p2: first.p2 }, after: after ? { p0: after.p0, p1: after.p1, p2: after.p2 } : null, firstFile: before.file };
  job.note = kept ? `anti-slop retry kept: P0 ${first.p0} -> ${after?.p0 ?? 0}` : `anti-slop retry not kept (${after ? `P0 ${after.p0}` : "retry failed"}), first answer shown`;
}

type KeyAcquisition = Awaited<ReturnType<KeyManager["acquireOrWait"]>>;

// A key pool with nothing to hand out. Not the job's fault, so mark skipped rather than
// error — the run summary then distinguishes infra exhaustion from model errors — unless
// the wait was itself cancelled, which cancels the job instead. Pulled out of
// runJobAttempts so this branching scores against this small function instead.
function markKeyUnavailable(job: Job, model: Model, acq: KeyAcquisition): string | null {
  if (acq.reason === "aborted") {
    job.status = "cancelled";
    return null;
  }
  const lastErr = acq.reason === "no_keys" ? `no API keys configured for ${model.keyEnv}` : `all keys cooling down (${model.keyEnv})`;
  job.status = "skipped";
  job.error = lastErr;
  return lastErr;
}

// Classifies a failed adapter.call: reports the key's health and says whether another key
// is worth trying. Returns null when the request was actually a cancellation, not a
// key/provider failure — the caller must not treat that as retryable. Pulled out of
// runJobAttempts, see markKeyUnavailable above.
function classifyJobCallError(err: unknown, ctx: JobWorkerContext, job: Job, model: Model, acq: KeyAcquisition): { retryable: boolean; message: string } | null {
  // A cancelled in-flight request isn't a key failure, don't cool the key.
  if (ctx.signal?.aborted) {
    job.status = "cancelled";
    ctx.km.release(model.keyEnv, acq.keyId, acq.leaseId);
    return null;
  }
  const provErr = err as ProviderError;
  const isProvider = provErr && provErr.name === "ProviderError";
  ctx.km.report(model.keyEnv, acq.keyId as string, {
    errorClass: isProvider ? provErr.errorClass : CLASS.UNKNOWN,
    retryAfterMs: isProvider ? provErr.retryAfterMs : null, // don't blame key for our bug
    message: provErr.message,
    leaseId: acq.leaseId,
  });
  return { retryable: isProvider ? provErr.retryable : false, message: provErr.message };
}

// One attempt per key in the pool (bounded by maxAttempts). acquire() already skips keys
// in cooldown, so a healthy pool never spends more than one attempt; only a pool full of
// dead/exhausted keys works through the budget. Returns the last error seen, if any.
async function runJobAttempts(ctx: JobWorkerContext, job: Job, model: Model, prompt: ResolvedPrompt, input: InputItem, adapter: ReturnType<typeof getAdapter>, built: PromptBuild, maxAttempts: number): Promise<string | null> {
  const { mock, signal, timeoutMs, systemContract, km } = ctx;
  let lastErr: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      job.status = "cancelled";
      break;
    }
    const acq = await km.acquireOrWait(model.keyEnv, 5000, signal);
    if (!acq.available) {
      lastErr = markKeyUnavailable(job, model, acq);
      break;
    }
    job.attempts = attempt;
    job.keyMask = acq.mask as string;
    try {
      const result = await adapter.call({
        model,
        apiKey: acq.key as string,
        systemContract,
        userPrompt: built.effectivePrompt,
        images: built.images,
        timeoutMs,
        signal,
        promptLabel: prompt.label,
        inputName: input.name,
      });
      // A mock success proves nothing about the real key, so don't record it
      // as validated health (a default mock run leaves key state untouched).
      if (!mock) km.report(model.keyEnv, acq.keyId as string, { errorClass: CLASS.OK, leaseId: acq.leaseId });
      else km.release(model.keyEnv, acq.keyId, acq.leaseId);

      const outcome = await finalizeJobResult(ctx, job, model, prompt, input, result, built, acq.mask as string);
      if (!outcome.ok) {
        lastErr = outcome.error;
        job.status = "error";
        job.error = lastErr.slice(0, 300);
        break;
      }
      lastErr = null;
      break;
    } catch (err) {
      const classified = classifyJobCallError(err, ctx, job, model, acq);
      if (!classified) break; // cancelled while the call was in flight
      lastErr = classified.message;
      if (!classified.retryable) {
        job.status = "error";
        break;
      }
      // else loop to next key
    }
  }

  return lastErr;
}

export async function runOneJob(job: Job, ctx: JobWorkerContext): Promise<void> {
  const { runId, manifest, mock, signal, km, modelById, promptById, inputById, onProgress, markManifestDirty } = ctx;
  const model = modelById.get(job.modelId) as Model;
  const prompt = promptById.get(job.promptId) as ReturnType<typeof resolvePrompts>[number];
  const input = inputById.get(job.inputId) as InputItem;
  const hasVision = model.vision !== false; // default to vision-capable
  const t0 = Date.now();
  // Pre-flight (captioning) time, kept OUT of job.ms. A text-only model waits on
  // a vision model's caption before it can start, and charging that wait to the
  // model made it look far slower than it generates — the UI lists these numbers
  // side by side, so they have to measure the same thing.
  let prepMs = 0;

  if (signal?.aborted) {
    job.status = "cancelled";
  } else {
    const adapter = getAdapter(model, { mock });
    const built = await buildJobPrompt(ctx, job, prompt, input, hasVision, t0);
    prepMs = built.prepMs;
    if (signal?.aborted) {
      // Captioning may finish after cancellation. Preserve that terminal state instead of
      // translating its null result into a retryable prerequisite failure.
      job.status = "cancelled";
    } else if (!hasVision && !built.caption) {
      // A text-only model has no other way to see the screenshot. Never turn a failed
      // caption helper into a paid generic redesign; retry becomes available once the
      // vision helper/key pool has recovered.
      job.status = "skipped";
      job.error = "screenshot caption is required before this text-only model can generate output";
      job.note = "screenshot caption unavailable; generation was not started";
    } else {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      onProgress({ type: "job", runId, job });

      const maxAttempts = km.attemptBudget(model.keyEnv);
      const lastErr = await runJobAttempts(ctx, job, model, prompt, input, adapter, built, maxAttempts);
      if (job.status === "ok") await retrySloppyOutput(ctx, job, model, prompt, input, adapter, built, maxAttempts);

      if (job.status !== "ok" && job.status !== "cancelled" && job.status !== "skipped") {
        job.status = "error";
        job.error = lastErr || "failed";
      }
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

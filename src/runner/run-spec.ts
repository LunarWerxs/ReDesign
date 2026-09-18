import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadModels, loadPrompts, resolveModels, resolvePrompts } from "../config";
import type { Model } from "../config/models";
import type { ResolvedPrompt } from "../config/prompts";
import { currentInputDir, REFERENCE_DIR, resolveReferences, resolveSelection, listInputs, type InputItem } from "../inputResolver";
import { ensureDir, resolveInside, normalizeSelectionIds, type SelectionInput } from "../util";
import { estimateRunCost } from "./cost";
import { cfgInt, getKeyManager } from "./helpers";
import type { RunReimagineOptions } from "./reimagine";
import { buildJobs, type Job } from "./scheduling";

const RUN_LIMITS = { jobs: 1000, assets: 256, assetBytes: 512 * 1024 * 1024, concurrency: 32, poolConcurrency: 8, quantity: 10, timeoutMs: 30 * 60_000 } as const;
function invalid(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }

interface RunSpec {
  version: 1;
  createdAt: string;
  label?: string;
  inputs: InputItem[];
  models: Model[];
  prompts: ResolvedPrompt[];
  systemContract: string;
  referenceRels: string[];
  referenceNote: string;
  visionHelper: Model | null;
  brandStyleGuide: string;
  settings: { mock: boolean; variants: number; variantsByModel: Record<string, number>; maxImagesPerInput?: number; concurrency: number; poolConcurrency: number; timeoutMs: number; maxCostUsd?: number };
  jobs: Job[];
  assets: Array<{ path: string; sha256: string; bytes: number }>;
  assetBytes: number;
  sourceRunId?: string;
}

function numberIn(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
function clampedEnv(name: string, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, cfgInt(name, fallback)));
}

function assertResolvedSelection(selection: SelectionInput, selected: string[], label: string): void {
  if (selection == null) return;
  const ids = normalizeSelectionIds(selection, { extraKeys: ["rels", "images", "ids"] });
  if (ids.length === 1 && ids[0] === "all") return;
  const missing = ids.filter((id) => !selected.includes(id));
  if (!ids.length || missing.length) throw invalid(`${label} selection is empty or unavailable: ${missing.join(", ")}`);
}

function safeRel(rel: string): string {
  const normalized = String(rel || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || !part)) throw new Error("invalid asset path");
  return normalized;
}

function realInside(base: string, rel: string): string {
  const candidate = resolveInside(base, rel, { allowBaseItself: false }).full;
  const baseReal = fs.realpathSync(base);
  const sourceReal = fs.realpathSync(candidate);
  if (!sourceReal.startsWith(baseReal + path.sep)) throw new Error("asset resolves outside its source directory");
  return sourceReal;
}

function copyAsset(sourceBase: string, rel: string, kind: "input" | "reference", targetDir: string, assets: RunSpec["assets"], bytesSoFar: { value: number }): string {
  const source = realInside(sourceBase, rel);
  const initialSize = fs.statSync(source).size;
  if (initialSize < 0 || bytesSoFar.value + initialSize > RUN_LIMITS.assetBytes) throw invalid("run assets exceed 512 MiB", 413);
  const hash = createHash("sha256");
  let copied = 0;
  const stagingDir = path.join(targetDir, "assets");
  ensureDir(stagingDir);
  const staging = path.join(stagingDir, `.copy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  // Bounded reads: reject growth while copying before buffering beyond the run cap.
  const fd = fs.openSync(source, "r");
  const out = fs.openSync(staging, "w");
  try {
    const block = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, initialSize)));
    for (;;) {
      const n = fs.readSync(fd, block, 0, block.length, null);
      if (!n) break;
      copied += n;
      if (bytesSoFar.value + copied > RUN_LIMITS.assetBytes) throw invalid("run assets exceed 512 MiB", 413);
      const chunk = block.subarray(0, n); hash.update(chunk); fs.writeSync(out, chunk);
    }
  } catch (error) {
    fs.closeSync(fd); fs.closeSync(out); fs.rmSync(staging, { force: true }); throw error;
  }
  fs.closeSync(fd); fs.closeSync(out);
  if (copied !== initialSize) { fs.rmSync(staging, { force: true }); throw new Error("asset changed while it was copied"); }
  const sha256 = hash.digest("hex");
  const durable = safeRel(path.posix.join("assets", kind, `${sha256}${path.extname(source).toLowerCase() || ".bin"}`));
  const destination = resolveInside(targetDir, durable, { allowBaseItself: false }).full;
  if (!fs.existsSync(destination)) {
    ensureDir(path.dirname(destination));
    fs.renameSync(staging, destination);
  } else fs.rmSync(staging, { force: true });
  if (!assets.some((asset) => asset.path === durable)) { assets.push({ path: durable, sha256, bytes: copied }); bytesSoFar.value += copied; }
  return durable;
}

function writeSpec(targetDir: string, spec: RunSpec): void {
  ensureDir(targetDir);
  const file = path.join(targetDir, "spec.json");
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(spec, null, 2));
  fs.renameSync(temp, file);
}

function matchesAsset(file: string, asset: RunSpec["assets"][number]): boolean {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > RUN_LIMITS.assetBytes || fs.statSync(file).size !== asset.bytes) return false;
  const descriptor = fs.openSync(file, "r");
  const block = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const count = fs.readSync(descriptor, block, 0, block.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > asset.bytes) return false;
      hash.update(block.subarray(0, count));
    }
  } finally { fs.closeSync(descriptor); }
  return bytes === asset.bytes && hash.digest("hex") === asset.sha256;
}

/** Version tag plus the five collections every later check indexes into. */
function hasSpecShape(value: RunSpec): boolean {
  return value.version === 1 && Array.isArray(value.assets) && Array.isArray(value.jobs) && Array.isArray(value.inputs) && Array.isArray(value.models) && Array.isArray(value.prompts);
}

/** Collection sizes and the shape of `settings`, checked before any element is dereferenced. */
function hasBoundedCollections(value: RunSpec): boolean {
  if (value.assets.length > RUN_LIMITS.assets) return false;
  if (!Number.isFinite(value.assetBytes) || value.assetBytes < 0 || value.assetBytes > RUN_LIMITS.assetBytes) return false;
  if (value.jobs.length > RUN_LIMITS.jobs || !value.settings || typeof value.settings !== "object") return false;
  return true;
}

function hasValidSettings(value: RunSpec): boolean {
  const settings = value.settings;
  return Number.isInteger(settings.variants) && settings.variants >= 1 && settings.variants <= RUN_LIMITS.quantity
    && Number.isInteger(settings.concurrency) && settings.concurrency >= 1 && settings.concurrency <= RUN_LIMITS.concurrency
    && Number.isInteger(settings.poolConcurrency) && settings.poolConcurrency >= 1 && settings.poolConcurrency <= RUN_LIMITS.poolConcurrency
    && Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0
    && (settings.maxCostUsd == null || (Number.isFinite(settings.maxCostUsd) && settings.maxCostUsd >= 0));
}

/** Every input image, preview and reference must name an asset the spec actually carries. */
function hasResolvableAssetRefs(value: RunSpec, paths: Set<string>): boolean {
  const inputsResolve = value.inputs.every((input) => Array.isArray(input.images) && input.images.length && input.images.every((image) => paths.has(image)) && paths.has(input.preview));
  return inputsResolve && value.referenceRels.every((rel) => paths.has(rel));
}

/** Job ids must be well formed and unique, and every foreign key must resolve. */
function hasValidJobs(value: RunSpec, inputIds: Set<string>, modelIds: Set<string>, promptIds: Set<string>): boolean {
  const expectedIds = new Set<string>();
  for (const job of value.jobs) {
    if (!job || !inputIds.has(job.inputId) || !modelIds.has(job.modelId) || !promptIds.has(job.promptId) || !Number.isInteger(job.variant) || job.variant < 1 || job.variant > RUN_LIMITS.quantity || !/^[A-Za-z0-9._-]+(?:__[A-Za-z0-9._-]+)+__v\d+$/.test(job.id) || expectedIds.has(job.id)) return false;
    expectedIds.add(job.id);
  }
  return true;
}

/** Re-hash every referenced asset from disk and confirm the total matches the declared size. */
function assetsMatch(value: RunSpec, dir: string): boolean {
  let total = 0;
  try {
    const rootReal = fs.realpathSync(dir);
    for (const asset of value.assets) {
      const rel = safeRel(asset.path);
      if (!rel.startsWith("assets/")) return false;
      const file = resolveInside(dir, rel, { allowBaseItself: false }).full;
      const fileReal = fs.realpathSync(file);
      if (!fileReal.startsWith(rootReal + path.sep)) return false;
      if (!matchesAsset(file, asset)) return false;
      total += asset.bytes;
    }
  } catch (_) { return false; }
  return total === value.assetBytes;
}

function validateSpec(spec: unknown, dir: string): RunSpec | null {
  if (!spec || typeof spec !== "object") return null;
  const value = spec as RunSpec;
  if (!hasSpecShape(value)) return null;
  if (!hasBoundedCollections(value)) return null;
  if (!hasValidSettings(value)) return null;
  const paths = new Set(value.assets.map((asset) => asset.path));
  const modelIds = new Set(value.models.map((model) => model.id));
  const promptIds = new Set(value.prompts.map((prompt) => prompt.id));
  const inputIds = new Set(value.inputs.map((input) => input.id));
  if (!hasResolvableAssetRefs(value, paths)) return null;
  if (!hasValidJobs(value, inputIds, modelIds, promptIds)) return null;
  return assetsMatch(value, dir) ? value : null;
}

/** Coerce and range-check every scalar option before any selection is resolved. */
function resolveRunSettings(options: RunReimagineOptions) {
  const variants = numberIn(options.variants, 1, 1, RUN_LIMITS.quantity, "variants");
  const concurrency = numberIn(options.concurrency, clampedEnv("MAX_CONCURRENCY", 12, RUN_LIMITS.concurrency), 1, RUN_LIMITS.concurrency, "concurrency");
  const poolConcurrency = numberIn(options.poolConcurrency, clampedEnv("MAX_POOL_CONCURRENCY", 4, RUN_LIMITS.poolConcurrency), 1, RUN_LIMITS.poolConcurrency, "pool concurrency");
  const timeoutMs = numberIn(options.timeoutMs, clampedEnv("REQUEST_TIMEOUT_MS", 120000, RUN_LIMITS.timeoutMs), 1, RUN_LIMITS.timeoutMs, "timeout");
  const requestedCap = options.maxImagesPerInput == null ? undefined : numberIn(options.maxImagesPerInput, 1, 1, Number.MAX_SAFE_INTEGER, "max images");
  const rawBudget = (options as RunReimagineOptions & { maxCostUsd?: unknown }).maxCostUsd;
  const maxCostUsd = rawBudget == null ? undefined : Number(rawBudget);
  if (maxCostUsd != null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw invalid("max cost must be a finite nonnegative number");
  const variantsByModel: Record<string, number> = {};
  for (const [modelId, quantity] of Object.entries(options.modelQuantities || {})) variantsByModel[modelId] = numberIn(quantity, variants, 1, RUN_LIMITS.quantity, `quantity for ${modelId}`);
  return { variants, concurrency, poolConcurrency, timeoutMs, requestedCap, maxCostUsd, variantsByModel };
}

/** Resolve inputs, models, prompts and references, then reject an empty or over-large combination. */
function resolveRunSelection(options: RunReimagineOptions, variants: number, variantsByModel: Record<string, number>) {
  const inputs = resolveSelection(listInputs(), options.inputs);
  const models = resolveModels(options.models);
  const prompts = resolvePrompts(options.prompts || {});
  assertResolvedSelection(options.inputs, inputs.flatMap((input) => [input.id, input.name]), "input");
  assertResolvedSelection(options.models, models.map((model) => model.id), "model");
  if (!inputs.length) throw invalid("No inputs matched the selection.");
  if (!models.length) throw invalid("No models matched the selection.");
  if (!prompts.length) throw invalid("No prompts resolved.");
  const predictedJobs = inputs.length * models.reduce((n, model) => n + prompts.length * (variantsByModel[model.id] || variants), 0);
  if (predictedJobs > RUN_LIMITS.jobs) throw invalid(`run exceeds ${RUN_LIMITS.jobs} jobs`, 413);
  const reference = options.reference;
  const selectedRefs = reference && reference.enabled !== false ? resolveReferences((reference.images ?? reference.rels ?? reference.ids ?? reference) as never) : [];
  if (reference && reference.enabled !== false && (reference.images != null || reference.rels != null || reference.ids != null)) {
    assertResolvedSelection((reference.images ?? reference.rels ?? reference.ids) as SelectionInput, selectedRefs, "reference");
  }
  return { inputs, models, prompts, selectedRefs };
}

/** Copy every selected image into the run directory and record its hash and size. */
function snapshotRunAssets(inputs: ReturnType<typeof resolveRunSelection>["inputs"], selectedRefs: string[], requestedCap: number | undefined, targetDir: string) {
  const cap = (rels: string[]) => requestedCap == null ? rels : rels.slice(0, requestedCap);
  const selectedAssetCount = inputs.reduce((count, input) => count + cap(input.images).length, 0) + cap(selectedRefs).length;
  if (selectedAssetCount > RUN_LIMITS.assets) throw invalid(`run exceeds ${RUN_LIMITS.assets} selected images`, 413);
  const assetList: RunSpec["assets"] = [];
  const byteCounter = { value: 0 };
  const durableInputs = inputs.map((input) => {
    const images = cap(input.images).map((rel) => copyAsset(currentInputDir(), rel, "input", targetDir, assetList, byteCounter));
    return { ...input, images, imageCount: images.length, preview: images[0] || input.preview };
  });
  if (durableInputs.some((input) => !input.images.length)) throw new Error("selected input has no images after applying max images");
  const referenceRels = cap(selectedRefs).map((rel) => copyAsset(REFERENCE_DIR, rel, "reference", targetDir, assetList, byteCounter));
  if (assetList.length > RUN_LIMITS.assets) throw invalid(`run exceeds ${RUN_LIMITS.assets} assets`, 413);
  const assetBytes = assetList.reduce((sum, asset) => sum + asset.bytes, 0);
  if (assetBytes > RUN_LIMITS.assetBytes) throw invalid("run assets exceed 512 MiB", 413);
  return { durableInputs, referenceRels, assetList, assetBytes };
}

/** Register every key pool the run may touch and pick the vision model that captions inputs. */
function pickVisionHelper(options: RunReimagineOptions, models: Model[]): Model | null {
  const km = options.keyManager || getKeyManager();
  for (const model of models) km.registerPool(model.keyEnv);
  const helperCandidates = [...models, ...loadModels().filter((model) => model.enabled !== false)].filter((model, index, all) => all.findIndex((other) => other.id === model.id) === index && model.vision !== false);
  for (const model of helperCandidates) km.registerPool(model.keyEnv);
  return helperCandidates.find((model) => km.availableCount(model.keyEnv) > 0) || helperCandidates.find((model) => km.poolSize(model.keyEnv) > 0) || null;
}

async function prepareRunSpec(options: RunReimagineOptions, targetDir: string): Promise<RunSpec> {
  const { variants, concurrency, poolConcurrency, timeoutMs, requestedCap, maxCostUsd, variantsByModel } = resolveRunSettings(options);
  const { inputs, models, prompts, selectedRefs } = resolveRunSelection(options, variants, variantsByModel);
  const { durableInputs, referenceRels, assetList, assetBytes } = snapshotRunAssets(inputs, selectedRefs, requestedCap, targetDir);
  const jobs = buildJobs({ inputItems: durableInputs, models, prompts, variants, variantsByModel });
  if (jobs.length > RUN_LIMITS.jobs) throw new Error(`run exceeds ${RUN_LIMITS.jobs} jobs`);
  const visionHelper = pickVisionHelper(options, models);
  const reference = options.reference;
  const spec: RunSpec ={ version: 1, createdAt: new Date().toISOString(), ...(options.label ? { label: options.label } : {}), inputs: durableInputs, models, prompts, systemContract: loadPrompts().systemContract, referenceRels, referenceNote: String(reference?.note || "").trim(), visionHelper, brandStyleGuide: String(options.brandStyleGuide || "").trim(), settings: { mock: !!options.mock, variants, variantsByModel, ...(requestedCap == null ? {} : { maxImagesPerInput: requestedCap }), concurrency, poolConcurrency, timeoutMs, ...(maxCostUsd == null ? {} : { maxCostUsd }) }, jobs, assets: assetList, assetBytes };
  writeSpec(targetDir, spec);
  return spec;
}

function readRunSpec(dir: string): RunSpec | null {
  try { return validateSpec(JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf8")), dir); } catch (_) { return null; }
}

async function cloneRunSpec(sourceDir: string, targetDir: string, jobIds?: string[]): Promise<RunSpec> {
  const source = readRunSpec(sourceDir);
  if (!source) throw invalid("source run spec is missing or corrupt", 409);
  const selected = jobIds?.length ? source.jobs.filter((job) => jobIds.includes(job.id)) : source.jobs;
  if (jobIds?.length && selected.length !== new Set(jobIds).size) throw new Error("requested job was not found in source spec");
  if (!selected.length) throw new Error("no jobs selected");
  if (selected.length > RUN_LIMITS.jobs) throw new Error(`run exceeds ${RUN_LIMITS.jobs} jobs`);
  const assets = source.assets.map((asset) => ({ ...asset }));
  if (assets.length > RUN_LIMITS.assets || source.assetBytes > RUN_LIMITS.assetBytes) throw new Error("source run exceeds asset limits");
  for (const asset of assets) {
    const src = resolveInside(sourceDir, safeRel(asset.path), { allowBaseItself: false }).full;
    const dest = resolveInside(targetDir, safeRel(asset.path), { allowBaseItself: false }).full;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    if (!matchesAsset(dest, asset)) throw invalid("source asset changed while preparing the retry", 409);
  }
  const inputIds = new Set(selected.map((job) => job.inputId));
  const modelIds = new Set(selected.map((job) => job.modelId));
  const promptIds = new Set(selected.map((job) => job.promptId));
  const cloned: RunSpec = { ...source, createdAt: new Date().toISOString(), inputs: source.inputs.filter((input) => inputIds.has(input.id)).map((input) => ({ ...input, images: [...input.images] })), models: source.models.filter((model) => modelIds.has(model.id)).map((model) => ({ ...model })), prompts: source.prompts.filter((prompt) => promptIds.has(prompt.id)).map((prompt) => ({ ...prompt })), jobs: selected.map((job) => ({ ...job })), assets, sourceRunId: source.sourceRunId || path.basename(sourceDir) };
  writeSpec(targetDir, cloned);
  return cloned;
}

function summarizeRunSpec(spec: RunSpec): { jobCount: number; assetBytes: number; estimatedCostUsd: number | null; unknownPricing: boolean } {
  if (spec.settings.mock) return { jobCount: spec.jobs.length, assetBytes: spec.assetBytes, estimatedCostUsd: 0, unknownPricing: false };
  const byModel: Record<string, number> = {};
  for (const job of spec.jobs) byModel[job.modelId] = (byModel[job.modelId] || 0) + 1;
  // One inventory caption per selected input, plus a style caption for text-only
  // runs with references and an untitled-run label request. These calls bill the helper.
  const selectedInputs = new Set(spec.jobs.map((job) => job.inputId)).size;
  const hasText = spec.jobs.some((job) => spec.models.find((model) => model.id === job.modelId)?.vision === false);
  const helperCalls = spec.visionHelper ? selectedInputs + (hasText && spec.referenceRels.length ? 1 : 0) + (spec.label ? 0 : 1) : 0;
  const helperIds = spec.visionHelper ? [spec.visionHelper.id] : [];
  if (spec.visionHelper && helperCalls) byModel[spec.visionHelper.id] = (byModel[spec.visionHelper.id] || 0) + helperCalls;
  const modelIds = [...new Set([...Object.keys(byModel), ...helperIds])];
  if (!modelIds.length) return { jobCount: 0, assetBytes: spec.assetBytes, estimatedCostUsd: 0, unknownPricing: false };
  const estimate = estimateRunCost({ modelIds, jobCount: Object.values(byModel).reduce((sum, count) => sum + count, 0), jobCountByModel: byModel });
  return { jobCount: spec.jobs.length, assetBytes: spec.assetBytes, estimatedCostUsd: estimate.anyUnpriced ? null : estimate.totalCost, unknownPricing: estimate.anyUnpriced };
}

export { RUN_LIMITS, prepareRunSpec, readRunSpec, cloneRunSpec, summarizeRunSpec };
export type { RunSpec };

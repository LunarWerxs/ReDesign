/** Materialize a bounded, private recipe before queue admission or any paid call. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store";
import { cloneRunSpec, prepareRunSpec, summarizeRunSpec, RUN_LIMITS, type RunSpec } from "../runner/run-spec";
import { getKeyManager } from "../runner/helpers";
import type { ReferenceOptions, RunReimagineOptions } from "../runner/reimagine";
import type { RunBody } from "./runQueue";

const PREFLIGHT_TTL_MS = 5 * 60_000;
const MAX_PREFLIGHTS = 10;
const MAX_PREFLIGHT_BYTES = 512 * 1024 * 1024;
const root = path.join(store.OUTPUT_DIR, ".preflight");
interface Prepared {
  dir: string;
  expiresAt: number;
  spec?: RunSpec;
  runId?: string;
}
const prepared = new Map<string, Prepared>();
let sweptAbandoned = false;

function reject(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function discard(token: string, entry: Prepared): void {
  prepared.delete(token);
  // These paths are created here from UUIDs; consumed run directories are never removed.
  if (!entry.runId && path.dirname(entry.dir) === root) fs.rmSync(entry.dir, { recursive: true, force: true });
}

function expire(): void {
  if (!sweptAbandoned) {
    sweptAbandoned = true;
    // A crash loses the expiry timers. Reclaim only our own recognizable temporary
    // directories when their creator PID is demonstrably dead.
    if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) {
      const match = /^(\d+)-[0-9a-f-]{36}$/.exec(name);
      if (!match) continue;
      try { process.kill(Number(match[1]), 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          const directory = path.resolve(root, name);
          if (path.dirname(directory) === path.resolve(root)) fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
  for (const [token, entry] of prepared) {
    if (entry.expiresAt <= Date.now()) discard(token, entry);
  }
}

function optionsFor(body: RunBody): RunReimagineOptions {
  return {
    label: body.label, mock: body.mock, inputs: body.inputs, models: body.models,
    prompts: body.prompts, variants: body.variants, modelQuantities: body.modelQuantities,
    maxImagesPerInput: body.maxImages, concurrency: body.concurrency, poolConcurrency: body.poolConcurrency,
    timeoutMs: body.timeoutMs as number | undefined,
    reference: body.reference as ReferenceOptions | null | undefined,
    brandStyleGuide: body.brandStyleGuide, maxCostUsd: body.maxCostUsd,
  };
}

async function materialize(make: (dir: string) => Promise<RunSpec>) {
  expire();
  if ([...prepared.values()].filter((entry) => !entry.runId).length >= MAX_PREFLIGHTS) reject("Too many prepared runs; submit one or wait five minutes for expiry.", 429);
  const preflightId = randomUUID();
  const entry: Prepared = { dir: path.join(root, `${process.pid}-${preflightId}`), expiresAt: Date.now() + PREFLIGHT_TTL_MS };
  prepared.set(preflightId, entry);
  try {
    entry.spec = await make(entry.dir);
    const totalBytes = [...prepared.values()].reduce((sum, item) => sum + (item.runId ? 0 : item.spec?.assetBytes || 0), 0);
    if (totalBytes > MAX_PREFLIGHT_BYTES) reject("Prepared assets exceed the 512 MiB temporary storage limit.", 413);
    const summary = summarizeRunSpec(entry.spec);
    // A requested ceiling cannot constrain a model with no price information.
    if (entry.spec.settings.maxCostUsd != null && !entry.spec.settings.mock && summary.unknownPricing) reject("A spend ceiling requires pricing for every selected model and caption helper.");
    const timer = setTimeout(() => {
      const current = prepared.get(preflightId);
      if (current === entry && current.expiresAt <= Date.now()) discard(preflightId, current);
    }, PREFLIGHT_TTL_MS + 1);
    timer.unref?.();
    const spec = entry.spec;
    const km = getKeyManager();
    const unavailable = spec.settings.mock ? [] : spec.models.flatMap((model) => {
      km.registerPool(model.keyEnv);
      if (!km.poolSize(model.keyEnv)) return [{ modelId: model.id, reason: "no configured keys" }];
      if (!km.availableCount(model.keyEnv)) return [{ modelId: model.id, reason: "all keys currently cooling down" }];
      if (model.vision === false && !spec.visionHelper) return [{ modelId: model.id, reason: "no vision helper for the required screenshot caption" }];
      return [];
    });
    return {
      preflightId, ...summary, expiresAt: entry.expiresAt,
      resolved: { inputIds: spec.inputs.map((input) => input.id), modelIds: spec.models.map((model) => model.id), promptIds: spec.prompts.map((prompt) => prompt.id) },
      effective: { concurrency: spec.settings.concurrency, poolConcurrency: spec.settings.poolConcurrency, timeoutMs: spec.settings.timeoutMs },
      unavailable, dropped: [], limits: { ...RUN_LIMITS, queuedRuns: 100, queuedAssetBytes: 1024 * 1024 * 1024 },
    };
  } catch (error) {
    discard(preflightId, entry);
    throw error;
  }
}

function prepareRun(body: RunBody) {
  return materialize((dir) => prepareRunSpec(optionsFor(body), dir));
}

function prepareReplay(sourceRunId: string, jobIds?: string[]) {
  const sourceDir = store.runDir(sourceRunId);
  return materialize((dir) => cloneRunSpec(sourceDir, dir, jobIds));
}

function getPrepared(token: string): Prepared & { spec: RunSpec } {
  expire();
  if (typeof token !== "string") reject("Invalid preflight token.");
  const entry = prepared.get(token);
  if (!entry?.spec) reject("Preflight expired or is unavailable; prepare the run again.", 409);
  return entry as Prepared & { spec: RunSpec };
}

function getPreparedSummary(token: string): { assetBytes: number; runId?: string } {
  const entry = getPrepared(token);
  return { assetBytes: entry.spec.assetBytes, ...(entry.runId ? { runId: entry.runId } : {}) };
}

function takePreparedRun(token: string): { runId: string; spec: RunSpec; reused: boolean } {
  const entry = getPrepared(token);
  if (entry.runId) return { runId: entry.runId, spec: entry.spec, reused: true };
  const runId = store.newRunId(entry.spec.label);
  fs.mkdirSync(store.OUTPUT_DIR, { recursive: true });
  fs.renameSync(entry.dir, store.runDir(runId));
  entry.runId = runId;
  return { runId, spec: entry.spec, reused: false };
}

/** Roll an admission back if its initial manifest could not be persisted. */
function undoPreparedRun(token: string, runId: string): void {
  const entry = prepared.get(token);
  if (!entry || entry.runId !== runId) return;
  try {
    fs.renameSync(store.runDir(runId), entry.dir);
    delete entry.runId;
  } catch (error) {
    // Never return a ghost run ID on a retry of an unsuccessful admission.
    prepared.delete(token);
    console.warn("Could not roll back prepared run admission:", error);
  }
}

export { prepareRun, prepareReplay, getPreparedSummary, takePreparedRun, undoPreparedRun };

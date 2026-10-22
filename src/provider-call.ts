/** Process-wide guard around actual provider requests.
 *
 * Adapters are deliberately unaware of pools.  This boundary still sees every
 * request, however, so it serializes a physical credential even when it appears
 * under several key-env pools and records the provider's reported usage in the
 * run that initiated it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { pricingLastUpdated } from "./config/pricing";
import { redactSecrets } from "./util";

export interface ProviderUsageEntry {
  modelId: string;
  provider: string;
  apiModel: string | null;
  pool: string;
  purpose: "generation" | "caption" | "reference_caption" | "title" | "health" | "asset_crop" | "other";
  promptLabel: string | null;
  usage: unknown;
  finishReason: string | null;
  /** true only when the provider supplied no usage object; no token estimate is made. */
  partial: boolean;
  pricingRevision: string | null;
  status: "ok" | "error";
  error: string | null;
  startedAt: string;
  ms: number;
  cost?: unknown;
  at: string;
}

export interface ProviderRunContext {
  recordUsage?: (entry: ProviderUsageEntry) => void;
  /** Called after a credential/slot is leased and immediately before network I/O. */
  beforeCall?: () => void;
  /** Per-pool cap shared by every run in this process. */
  poolConcurrency?: number;
  /** Global cap shared by every run in this process. */
  concurrency?: number;
}

interface CallMeta {
  pool: string;
  apiKey: string;
  modelId?: string;
  provider?: string;
  apiModel?: string;
  promptLabel?: string;
  signal?: AbortSignal | null;
}

interface ProviderResponseLike { usage?: unknown; finishReason?: string | null | undefined }
interface UsageErrorLike { usage?: unknown; finishReason?: string | null | undefined }

const runs = new AsyncLocalStorage<ProviderRunContext>();
const tails = new Map<string, Promise<void>>();
interface NetworkWaiter { pool: string; globalLimit: number; poolLimit: number; resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal | null; onAbort?: () => void }
interface NetworkState { globalLimit: number; active: number; pools: Map<string, { limit: number; active: number }>; waiters: NetworkWaiter[] }
const network: NetworkState = { globalLimit: Number.MAX_SAFE_INTEGER, active: 0, pools: new Map(), waiters: [] };

function defaultLimit(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function aborted(): Error {
  const error = new Error("provider call cancelled");
  error.name = "AbortError";
  return error;
}

function budgetRejected(error: unknown): Error {
  const out = error instanceof Error ? error : new Error(String(error));
  // Keep the boundary dependency-free while allowing existing key rotation to
  // recognize a preflight denial as a non-key, non-retryable provider outcome.
  Object.assign(out, { name: "ProviderError", errorClass: "bad_request", retryAfterMs: null, retryable: false, nonBillable: true });
  return out;
}

async function acquireSerial(tailMap: Map<string, Promise<void>>, key: string, signal: AbortSignal | null | undefined): Promise<() => void> {
  if (signal?.aborted) throw aborted();
  const previous = tailMap.get(key) || Promise.resolve();
  const { promise: mine, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.then(() => mine);
  tailMap.set(key, tail);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      previous.then(resolve, reject);
      signal?.addEventListener("abort", onAbort, { once: true });
      previous.finally(() => signal?.removeEventListener("abort", onAbort));
    });
    if (signal?.aborted) throw aborted();
  } catch (error) {
    release();
    throw error;
  }
  return () => {
    release();
    if (tailMap.get(key) === tail) tailMap.delete(key);
  };
}

function waitForPhysicalKey(key: string, signal: AbortSignal | null | undefined): Promise<() => void> {
  return acquireSerial(tails, key, signal);
}

function drainNetwork(): void {
  for (let i = 0; i < network.waiters.length;) {
    const waiter = network.waiters[i] as NetworkWaiter;
    const pool = network.pools.get(waiter.pool) || { limit: waiter.poolLimit, active: 0 };
    network.globalLimit = Math.min(network.globalLimit, waiter.globalLimit);
    pool.limit = Math.min(pool.limit, waiter.poolLimit);
    network.pools.set(waiter.pool, pool);
    if (network.active >= network.globalLimit || pool.active >= pool.limit) { i++; continue; }
    network.waiters.splice(i, 1);
    waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
    network.active++;
    pool.active++;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      network.active--;
      pool.active--;
      if (!network.active && !network.waiters.length) {
        network.globalLimit = Number.MAX_SAFE_INTEGER;
        network.pools.clear();
      }
      drainNetwork();
    });
  }
}

function acquireNetwork(pool: string, context: ProviderRunContext | undefined, signal: AbortSignal | null | undefined): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const waiter: NetworkWaiter = {
      pool,
      globalLimit: Math.max(1, context?.concurrency || defaultLimit("MAX_CONCURRENCY", 12)),
      poolLimit: Math.max(1, context?.poolConcurrency || defaultLimit("MAX_POOL_CONCURRENCY", 4)),
      resolve,
      reject,
      signal,
    };
    waiter.onAbort = () => {
      const index = network.waiters.indexOf(waiter);
      if (index >= 0) network.waiters.splice(index, 1);
      reject(aborted());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    network.waiters.push(waiter);
    drainNetwork();
  });
}

function record(meta: CallMeta, result: ProviderResponseLike | UsageErrorLike, status: "ok" | "error", error: unknown, startedAt: string, ms: number): void {
  const context = runs.getStore();
  if (!context?.recordUsage || !meta.modelId || !meta.provider) return;
  const purpose = meta.promptLabel === "caption" ? "caption" : meta.promptLabel === "ref-caption" ? "reference_caption" : meta.promptLabel === "run-label" ? "title" : meta.promptLabel === "healthcheck" ? "health" : meta.promptLabel === "asset-crop" ? "asset_crop" : meta.promptLabel ? "generation" : "other";
  context.recordUsage({
    modelId: meta.modelId,
    provider: meta.provider,
    apiModel: meta.apiModel || null,
    pool: meta.pool,
    purpose,
    promptLabel: meta.promptLabel || null,
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    partial: result.usage == null,
    pricingRevision: pricingLastUpdated(),
    status,
    error: status === "error" ? ((redactSecrets(error instanceof Error ? error.message : String(error)) || "").slice(0, 300) || "provider call failed") : null,
    startedAt,
    ms,
    at: new Date().toISOString(),
  });
}

function withProviderRun<T>(context: ProviderRunContext, operation: () => Promise<T>): Promise<T> {
  return runs.run(context, operation);
}

async function providerCall<T>(meta: CallMeta, operation: () => Promise<T>): Promise<T> {
  const context = runs.getStore();
  // Physical-key waiters never hold a network permit.  This lets another helper
  // or provider key proceed while an overlapping credential is still in flight.
  const release = await waitForPhysicalKey(meta.apiKey, meta.signal);
  let releaseNetwork: (() => void) | null = null;
  let callStartedAt: string | null = null;
  let callStartedMs = 0;
  try {
    releaseNetwork = await acquireNetwork(meta.pool, context, meta.signal);
    try {
      context?.beforeCall?.();
    } catch (error) {
      throw budgetRejected(error);
    }
    callStartedAt = new Date().toISOString();
    callStartedMs = Date.now();
    const result = await operation();
    record(meta, result as ProviderResponseLike, "ok", null, callStartedAt, Date.now() - callStartedMs);
    return result;
  } catch (error) {
    // Empty/provider-error replies can still carry a billable usage block.
    if (!(error && typeof error === "object" && (error as { nonBillable?: unknown }).nonBillable)) record(meta, error as UsageErrorLike, "error", error, callStartedAt || new Date().toISOString(), callStartedMs ? Date.now() - callStartedMs : 0);
    throw error;
  } finally {
    releaseNetwork?.();
    release();
  }
}

export { providerCall, withProviderRun };
export type { CallMeta };

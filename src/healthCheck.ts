import { mapLimit } from "./util";
import { CLASS, type KeyManager } from "./keyManager";
import { getAdapter, type ProviderError } from "./providers";
import type { Model } from "./config/models";

interface CancelledError extends Error {
  cancelled: boolean;
  status: number;
}

function cancelledError(): CancelledError {
  const err = new Error("health check cancelled") as CancelledError;
  err.name = "AbortError";
  err.cancelled = true;
  err.status = 499;
  return err;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

interface Verdict {
  status: "alive" | "dead" | "no_balance" | "throttled" | "inconclusive";
  report: string;
}

// Map a ping outcome to a friendly status + the class to report to the manager.
function interpret(ok: boolean, err: ProviderError | null): Verdict {
  if (ok) return { status: "alive", report: CLASS.OK };
  const cls = err?.errorClass;
  switch (cls) {
    case CLASS.AUTH:
      return { status: "dead", report: CLASS.AUTH };
    case CLASS.NO_BALANCE:
      return { status: "no_balance", report: CLASS.NO_BALANCE };
    case CLASS.BAD_REQUEST:
      // A 200 that produced no usable text still proves the key authenticates.
      return { status: "alive", report: CLASS.OK };
    case CLASS.RATE_LIMIT:
      return { status: "throttled", report: CLASS.RATE_LIMIT };
    case CLASS.SERVER:
    case CLASS.NETWORK:
      return { status: "inconclusive", report: cls };
    default:
      return { status: "inconclusive", report: CLASS.UNKNOWN };
  }
}

interface HealthCheckRow {
  mask: string;
  status: Verdict["status"];
  detail: string;
}

interface HealthCheckResult {
  model: string;
  pool: string;
  total: number;
  alive: number;
  dead: number;
  noBalance: number;
  throttled: number;
  rows: HealthCheckRow[];
}

interface HealthCheckOptions {
  timeoutMs?: number;
  concurrency?: number;
  onResult?: (model: Model, row: HealthCheckRow) => void;
  signal?: AbortSignal | null;
}

/**
 * Ping every key in a model's pool with a tiny request to learn which keys
 * authenticate, which are out of balance, and which are dead. Updates the key
 * manager so the knowledge persists. THIS SPENDS A SMALL AMOUNT OF QUOTA.
 */
async function healthCheckModel(km: KeyManager, model: Model, { timeoutMs = 30000, concurrency = 4, onResult, signal }: HealthCheckOptions = {}): Promise<HealthCheckResult> {
  throwIfAborted(signal);
  km.registerPool(model.keyEnv);
  const entries = km.getEntries(model.keyEnv);
  const adapter = getAdapter(model, { mock: false });
  const pingModel: Model = { ...model, maxTokens: 32 };

  const results = await mapLimit(entries, concurrency, async (entry) => {
    throwIfAborted(signal);
    let ok = false;
    let err: ProviderError | null = null;
    try {
      await adapter.call({
        model: pingModel,
        apiKey: entry.key,
        systemContract: "You are a health check. Reply with the single word: OK",
        userPrompt: "OK",
        images: [],
        timeoutMs,
        signal,
        promptLabel: "healthcheck",
        inputName: "ping",
      });
      ok = true;
    } catch (e) {
      if (signal?.aborted) throw cancelledError();
      err = e as ProviderError;
    }
    const verdict = interpret(ok, err);
    km.report(model.keyEnv, entry.id, {
      errorClass: verdict.report as any,
      retryAfterMs: err?.retryAfterMs,
      message: err?.message,
    });
    const row: HealthCheckRow = { mask: entry.mask, status: verdict.status, detail: err ? err.message : "ok" };
    if (onResult) onResult(model, row);
    return row;
  });

  km.save();
  throwIfAborted(signal);
  const rows: HealthCheckRow[] = results.map((r) => (r.ok ? r.value : { mask: "?", status: "inconclusive", detail: String(r.error) }));
  return {
    model: model.id,
    pool: model.keyEnv,
    total: rows.length,
    alive: rows.filter((r) => r.status === "alive").length,
    dead: rows.filter((r) => r.status === "dead").length,
    noBalance: rows.filter((r) => r.status === "no_balance").length,
    throttled: rows.filter((r) => r.status === "throttled").length,
    rows,
  };
}

export { healthCheckModel };
export type { HealthCheckResult, HealthCheckRow, HealthCheckOptions };

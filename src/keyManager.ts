import path from "node:path";
import { ROOT, getKeyPool, keyId, maskKey, readJSON, writeJSON, sleep, redactSecrets } from "./util";

const STATE_FILE = path.join(ROOT, "src", "keyState.json");

// Outcome classes a provider adapter can report. Each maps to a cooldown.
const CLASS = {
  OK: "ok",
  RATE_LIMIT: "rate_limit", // 429 / overloaded, back off briefly
  NO_BALANCE: "no_balance", // 402 / insufficient quota, long cooldown
  AUTH: "auth", // 401 / explicit invalid or revoked key, effectively dead
  PERMISSION: "permission", // 403 resource/model access denied; not a key-health failure
  SERVER: "server", // 5xx, transient, short cooldown
  NETWORK: "network", // timeout / fetch failure, short cooldown
  BAD_REQUEST: "bad_request", // 400, request problem, NOT the key's fault
  UNKNOWN: "unknown",
} as const;

type ErrorClass = (typeof CLASS)[keyof typeof CLASS];

function cfgInt(name: string, def: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

interface KeyEntry {
  key: string; // secret, in memory only
  id: string;
  composite: string;
  pool: string;
  mask: string;
  status: string;
  cooldownUntil: number;
  successes: number;
  failures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
}

interface Pool {
  name: string;
  entries: KeyEntry[];
  rr: number;
}

interface PersistedKeyState {
  pool: string;
  mask: string;
  status: string;
  cooldownUntil: number;
  successes: number;
  failures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
}

interface PersistedState {
  version: number;
  keys: Record<string, PersistedKeyState>;
  updatedAt?: string;
}

interface AcquireResult {
  available: boolean;
  key?: string;
  keyId?: string;
  mask?: string;
  entry?: KeyEntry;
  leaseId?: number;
  reason?: "no_keys" | "all_cooldown" | "busy" | "aborted";
  waitMs?: number;
}

interface ReportOptions {
  errorClass?: ErrorClass;
  retryAfterMs?: number | null;
  message?: string | null;
  leaseId?: number;
}

interface KeyManagerOptions {
  cooldowns?: Partial<Record<ErrorClass, number>>;
  stateFile?: string;
}

interface SnapshotEntry {
  id: string;
  mask: string;
  status: string;
  availableNow: boolean;
  cooldownUntil: number;
  cooldownRemainingSec: number;
  successes: number;
  failures: number;
  lastError: string | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
}

interface SnapshotPool {
  pool: string;
  total: number;
  available: number;
  dead: number;
  noBalance: number;
  cooling: number;
  entries: SnapshotEntry[];
}

interface Snapshot {
  updatedAt: string;
  pools: SnapshotPool[];
}

/**
 * Manages pools of API keys with round-robin selection, automatic cooldown of
 * failing keys, and persistent health tracking. State is keyed by a non-secret
 * fingerprint so the secret never touches disk.
 */
class KeyManager {
  cooldowns: Record<ErrorClass, number>;
  stateFile: string;
  pools: Map<string, Pool>;
  _dirty: boolean;
  _saveTimer: ReturnType<typeof setTimeout> | null;
  _persisted: PersistedState;
  /** Credential fingerprints currently assigned to a request, shared by every pool. */
  _leasedKeys: Map<string, number>;
  _leaseSequence: number;
  _leaseWaiters: Set<() => void>;

  constructor(opts: KeyManagerOptions = {}) {
    this.cooldowns = {
      [CLASS.RATE_LIMIT]: cfgInt("COOLDOWN_RATE_LIMIT_SEC", 60) * 1000,
      [CLASS.NO_BALANCE]: cfgInt("COOLDOWN_NO_BALANCE_SEC", 3600) * 1000,
      [CLASS.AUTH]: cfgInt("COOLDOWN_DEAD_SEC", 86400) * 1000,
      [CLASS.PERMISSION]: 0, // permission belongs to the operation, not the credential
      [CLASS.SERVER]: 15 * 1000,
      [CLASS.NETWORK]: 15 * 1000,
      [CLASS.UNKNOWN]: 30 * 1000,
      [CLASS.BAD_REQUEST]: 0, // never penalize the key for a 400
      [CLASS.OK]: 0,
      ...(opts.cooldowns || {}),
    };
    this.stateFile = opts.stateFile || STATE_FILE;
    this.pools = new Map(); // poolName -> { name, entries:[], rr:0 }
    this._dirty = false;
    this._saveTimer = null;
    this._persisted = readJSON<PersistedState>(this.stateFile, { version: 1, keys: {} });
    this._leasedKeys = new Map();
    this._leaseSequence = 0;
    this._leaseWaiters = new Set();
    if (!this._persisted.keys) this._persisted.keys = {};
  }

  // Build (or rebuild) a pool from an env var, merging persisted health.
  registerPool(poolName: string): Pool {
    const existing = this.pools.get(poolName);
    if (existing) return existing;
    const keys = getKeyPool(poolName);
    const entries: KeyEntry[] = keys.map((key) => {
      const id = keyId(key);
      const composite = `${poolName}::${id}`;
      const saved = this._persisted.keys[composite] || ({} as Partial<PersistedKeyState>);
      return {
        key, // secret, in memory only
        id,
        composite,
        pool: poolName,
        mask: maskKey(key),
        status: saved.status || "untested",
        cooldownUntil: saved.cooldownUntil || 0,
        successes: saved.successes || 0,
        failures: saved.failures || 0,
        lastError: saved.lastError || null,
        lastErrorAt: saved.lastErrorAt || null,
        lastUsedAt: saved.lastUsedAt || null,
        lastSuccessAt: saved.lastSuccessAt || null,
      };
    });
    const pool: Pool = { name: poolName, entries, rr: 0 };
    this.pools.set(poolName, pool);
    return pool;
  }

  poolSize(poolName: string): number {
    const p = this.pools.get(poolName) || this.registerPool(poolName);
    return p.entries.length;
  }

  /**
   * How many keys in the pool are usable RIGHT NOW: not dead, not out of balance,
   * not cooling down. poolSize() counts every key ever configured, so a pool whose
   * keys are all revoked still reports a healthy size — callers that need to know
   * "can this pool actually serve a request" must ask this instead.
   */
  availableCount(poolName: string): number {
    const p = this.pools.get(poolName) || this.registerPool(poolName);
    const now = Date.now();
    return p.entries.filter((e) => (e.cooldownUntil || 0) <= now).length;
  }

  /**
   * How many key-rotation attempts one request should get. A dead/exhausted key must
   * not fail the request while other keys are sitting there unused, so the budget is
   * the whole pool (bounded by MAX_KEY_ATTEMPTS) rather than a small fixed number.
   * acquire() already skips keys in cooldown, so on a healthy pool this costs nothing:
   * the loop exits on the first success, and only a genuinely broken pool spends the
   * full budget.
   */
  attemptBudget(poolName: string, cap = cfgInt("MAX_KEY_ATTEMPTS", 10)): number {
    return Math.max(1, Math.min(this.poolSize(poolName) || 1, Math.max(1, cap)));
  }

  // Internal accessor: returns live entries INCLUDING the secret key. Only used
  // by the health-check, which must ping each specific key. Never serialize.
  getEntries(poolName: string): KeyEntry[] {
    const p = this.pools.get(poolName) || this.registerPool(poolName);
    return p.entries;
  }

  reloadPool(poolName: string): Pool {
    this.pools.delete(poolName);
    return this.registerPool(poolName);
  }

  forget(poolName: string, ids: string | string[] | undefined): void {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).filter((x): x is string => !!x));
    if (!set.size) return;
    for (const id of set) delete this._persisted.keys[`${poolName}::${id}`];
    this.save();
  }

  /**
   * Pick the next usable key from a pool using round-robin, skipping any key
   * still in cooldown. Returns { available, key?, keyId?, mask?, reason?, waitMs? }.
   */
  acquire(poolName: string): AcquireResult {
    const pool = this.pools.get(poolName) || this.registerPool(poolName);
    const n = pool.entries.length;
    if (!n) return { available: false, reason: "no_keys" };
    const now = Date.now();
    for (let step = 0; step < n; step++) {
      const idx = (pool.rr + step) % n;
      const e = pool.entries[idx] as KeyEntry;
      // A physical credential may be configured in several pools.  Do not hand it
      // to two requests at once: a late success from the first must never erase a
      // cooldown reported by the second.
      if ((e.cooldownUntil || 0) <= now && !this._leasedKeys.has(e.id)) {
        pool.rr = (idx + 1) % n;
        const leaseId = ++this._leaseSequence;
        this._leasedKeys.set(e.id, leaseId);
        e.lastUsedAt = now;
        return { available: true, key: e.key, keyId: e.id, mask: e.mask, entry: e, leaseId };
      }
    }
    let soonest = Number.POSITIVE_INFINITY;
    for (const e of pool.entries) soonest = Math.min(soonest, e.cooldownUntil || 0);
    const busy = pool.entries.some((e) => (e.cooldownUntil || 0) <= now && this._leasedKeys.has(e.id));
    return busy ? { available: false, reason: "busy" } : { available: false, reason: "all_cooldown", waitMs: Math.max(0, soonest - now) };
  }

  /**
   * Like acquire(), but if every key is cooling down it will wait (up to
   * maxWaitMs) for the soonest one to free up rather than failing immediately.
   */
  async acquireOrWait(poolName: string, maxWaitMs = 0, signal: AbortSignal | null = null): Promise<AcquireResult> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      if (signal?.aborted) return { available: false, reason: "aborted" };
      const res = this.acquire(poolName);
      if (res.available || res.reason === "no_keys") return res;
      if (res.reason === "busy") {
        await this._waitForLease(signal);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return res;
      // Cap each nap at 1s so an AbortSignal is observed promptly.
      await sleep(Math.min((res.waitMs || 0) + 50, remaining, 1000));
    }
  }

  /** Lease one named credential for health probing without stealing a generation lease. */
  async acquireSpecificOrWait(poolName: string, kid: string, maxWaitMs = 0, signal: AbortSignal | null = null): Promise<AcquireResult> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      if (signal?.aborted) return { available: false, reason: "aborted" };
      const pool = this.pools.get(poolName) || this.registerPool(poolName);
      const entry = pool.entries.find((e) => e.id === kid);
      if (!entry) return { available: false, reason: "no_keys" };
      const now = Date.now();
      if (this._leasedKeys.has(kid)) { await this._waitForLease(signal); continue; }
      if ((entry.cooldownUntil || 0) > now) {
        const remaining = deadline - now;
        if (remaining <= 0) return { available: false, reason: "all_cooldown", waitMs: entry.cooldownUntil - now };
        await sleep(Math.min(entry.cooldownUntil - now, remaining, 1000));
        continue;
      }
      const leaseId = ++this._leaseSequence;
      this._leasedKeys.set(kid, leaseId);
      entry.lastUsedAt = now;
      return { available: true, key: entry.key, keyId: entry.id, mask: entry.mask, entry, leaseId };
    }
  }

  // Record the result of using a key. `errorClass` comes from CLASS.*.
  report(poolName: string, kid: string, { errorClass = CLASS.OK, retryAfterMs = null, message = null, leaseId }: ReportOptions = {}): void {
    if (leaseId != null && this._leasedKeys.get(kid) !== leaseId) return;
    this._releaseLease(kid, leaseId);
    const pool = this.pools.get(poolName);
    if (!pool) return;
    const e = pool.entries.find((x) => x.id === kid);
    if (!e) return;
    const now = Date.now();
    if (errorClass === CLASS.OK) {
      e.successes++;
      e.status = "ok";
      e.cooldownUntil = 0;
      e.lastSuccessAt = now;
      e.lastError = null;
    } else {
      e.failures++;
      e.lastError = redactSecrets(message ? String(message).slice(0, 300) : errorClass) ?? null;
      e.lastErrorAt = now;
      const base = this.cooldowns[errorClass] != null ? this.cooldowns[errorClass] : this.cooldowns[CLASS.UNKNOWN];
      // Only honor a provider's Retry-After for transient classes. For AUTH /
      // NO_BALANCE the full long cooldown must stand, otherwise a tiny
      // Retry-After would revive a known-dead/out-of-balance key in seconds.
      const honorRetry = errorClass === CLASS.RATE_LIMIT || errorClass === CLASS.SERVER || errorClass === CLASS.NETWORK;
      const cd = honorRetry && retryAfterMs != null ? Math.max(retryAfterMs, 1000) : base;
      if (cd > 0) e.cooldownUntil = now + cd;
      if (errorClass === CLASS.AUTH) e.status = "dead";
      else if (errorClass === CLASS.NO_BALANCE) e.status = "no_balance";
      else if (errorClass === CLASS.BAD_REQUEST || errorClass === CLASS.PERMISSION) {
        /* request/content/resource permission problems do not affect key health */
      } else e.status = "cooldown";
    }
    this._mirror(e);
    // A physical key can live in two pools (Gemini flash + pro). Any cooldown
    // applies to the credential, not the model alias, so mirror it everywhere.
    if ((e.cooldownUntil || 0) > now) this._propagate(e);
    this._scheduleSave();
  }

  /** Release an acquired key when a caller was cancelled before it had an outcome. */
  release(_poolName: string, kid: string | undefined, leaseId?: number): void {
    if (kid) this._releaseLease(kid, leaseId);
  }

  _releaseLease(kid: string, leaseId?: number): void {
    if (leaseId != null && this._leasedKeys.get(kid) !== leaseId) return;
    if (!this._leasedKeys.delete(kid)) return;
    for (const wake of this._leaseWaiters) wake();
    this._leaseWaiters.clear();
  }

  _waitForLease(signal: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => { signal?.removeEventListener("abort", wake); resolve(); };
      this._leaseWaiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }

  _propagate(src: KeyEntry): void {
    for (const [, pool] of this.pools) {
      if (pool.name === src.pool) continue;
      const e = pool.entries.find((x) => x.id === src.id);
      if (!e) continue;
      if ((src.cooldownUntil || 0) > (e.cooldownUntil || 0)) {
        e.cooldownUntil = src.cooldownUntil;
        e.status = src.status;
        e.lastError = src.lastError;
        e.lastErrorAt = src.lastErrorAt;
        this._mirror(e);
      }
    }
  }

  _mirror(e: KeyEntry): void {
    this._persisted.keys[e.composite] = {
      pool: e.pool,
      mask: e.mask,
      status: e.status,
      cooldownUntil: e.cooldownUntil,
      successes: e.successes,
      failures: e.failures,
      lastError: e.lastError,
      lastErrorAt: e.lastErrorAt,
      lastUsedAt: e.lastUsedAt,
      lastSuccessAt: e.lastSuccessAt,
    };
  }

  _scheduleSave(): void {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  save(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._persisted.version = 1;
    this._persisted.updatedAt = new Date().toISOString();
    writeJSON(this.stateFile, this._persisted);
    this._dirty = false;
  }

  // Sanitized view for dashboards / CLI, never includes the secret.
  snapshot(): Snapshot {
    const now = Date.now();
    const pools: SnapshotPool[] = [];
    for (const [name, pool] of this.pools) {
      const entries: SnapshotEntry[] = pool.entries.map((e) => ({
        id: e.id,
        mask: e.mask,
        status: e.status,
        availableNow: (e.cooldownUntil || 0) <= now,
        cooldownUntil: e.cooldownUntil || 0,
        cooldownRemainingSec: Math.max(0, Math.round(((e.cooldownUntil || 0) - now) / 1000)),
        successes: e.successes,
        failures: e.failures,
        lastError: e.lastError,
        lastUsedAt: e.lastUsedAt,
        lastSuccessAt: e.lastSuccessAt,
      }));
      pools.push({
        pool: name,
        total: entries.length,
        available: entries.filter((e) => e.availableNow && e.status !== "dead").length,
        dead: entries.filter((e) => e.status === "dead").length,
        noBalance: entries.filter((e) => e.status === "no_balance").length,
        cooling: entries.filter((e) => !e.availableNow).length,
        entries,
      });
    }
    return { updatedAt: new Date(now).toISOString(), pools };
  }
}

export { KeyManager, CLASS };
export type { ErrorClass, KeyEntry, Pool, AcquireResult, ReportOptions, Snapshot, SnapshotPool, SnapshotEntry };

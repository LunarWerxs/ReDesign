/**
 * Anonymous install/usage ping — the shared Studio "app-ping" contract already live for
 * QuickDictate and AnatomyOf. `GET https://studio.connections.icu/v1/app/redesign/latest`
 * returns GitHub's `releases/latest` JSON for LunarWerxs/ReDesign verbatim, so the SAME hit is
 * both an update check and an anonymous install-count row logged server-side (random install
 * id + app version + coarse OS only; never an IP, hostname, username, or path).
 *
 * Two call sites share the id/query/header plumbing built here:
 *   - github-updater.ts's real release check (packaged builds only) decorates its EXISTING
 *     fetch to this same URL instead of adding a second one — packaged installs get the ping for
 *     free every time they check for updates.
 *   - pingInstallOnBoot(), fired once from cli/lifecycle.ts's serveCmd on every daemon start,
 *     covers everything github-updater.ts doesn't: from-source checkouts (which update via git
 *     through updater-engine.mjs, never touching this URL) and any packaged run that never opens
 *     the web UI (so the frontend-triggered update check never fires). Throttled to at most once
 *     per 24h via a persisted timestamp so restarting the daemon often never spams the endpoint.
 *
 * This repoints the DORMANT `recordPulse`/`POST /api/pulse` mechanism that used to live in
 * http/routes/bootstrap.ts: event-named posts to an operator-supplied REDESIGN_PULSE_URL that no
 * collector has ever existed for (the URL env var was never set in the wild, so recordPulse
 * always returned `{ ok: true, enabled: false }` without even minting an install id). That system,
 * and every call site that fed it, is deleted in this same change rather than kept alongside this.
 */
import os from "node:os";
import path from "node:path";
import pkg from "../package.json";
import { ROOT, readJSON, writeJSON } from "./util";

/** Shared by github-updater.ts so both call sites hit the exact same URL. */
export const PING_URL = "https://studio.connections.icu/v1/app/redesign/latest";

// Reuses the dormant mechanism's old state file (gitignored, alongside the other small local
// state files under output/) rather than adding a new one.
const STATE_FILE = path.join(ROOT, "output", ".reimagine-state.json");

/** At most one boot ping per this interval, persisted across restarts. */
const THROTTLE_MS = 24 * 60 * 60 * 1000;

interface PingState {
  installId?: string;
  /** Set once this install's first successful ping has landed (only after a real 2xx). */
  installReported?: boolean;
  lastPingAt?: string;
  /** Dead fields from the retired dormant-pulse mechanism, migrated away on first load. */
  pulseInstallId?: string;
  analyticsInstallId?: string;
}

// Re-read from disk on every call rather than caching in memory: this fires at most a handful of
// times per process lifetime, so the cost is negligible, and always reading fresh means a test
// (or a second process) that rewrites the state file is always seen, no cache-invalidation to get
// wrong.
function load(): PingState {
  const state = readJSON<PingState>(STATE_FILE, {});
  if (!state.installId) state.installId = state.pulseInstallId || state.analyticsInstallId;
  delete state.pulseInstallId;
  delete state.analyticsInstallId;
  return state;
}

function save(state: PingState): void {
  writeJSON(STATE_FILE, state);
}

/** Get-or-create the random per-install id, persisted in the app's own state file. Deliberately
 *  never derived from hostname, MAC, username, or anything else machine-identifying. */
export function getInstallId(): string {
  const state = load();
  if (!state.installId) {
    state.installId = crypto.randomUUID();
    save(state);
  }
  return state.installId;
}

/** Coarse OS tag: "win11"/"win10" (from the Windows build number), "macos", "linux", or the bare
 *  `process.platform` for anything else. Never the exact build, kernel version, or arch. */
export function coarseOsTag(): string {
  if (process.platform === "win32") {
    const build = Number(os.release().split(".")[2] ?? 0);
    return build >= 22000 ? "win11" : "win10";
  }
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return process.platform;
}

/** Skip in dev/test/CI runs and whenever the owner opted out. */
function pingDisabled(): boolean {
  return (
    process.env.REDESIGN_NO_PING === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    Boolean(process.env.CI)
  );
}

/** One fire-and-forget hit: <=5s timeout, every failure swallowed, never throws, no retries. Sends
 *  `&new=1` exactly once, on this install's first-ever successful ping (persisted only after a
 *  real 2xx, so a flaky first attempt tries again next time instead of forever claiming credit). */
async function ping(): Promise<void> {
  const state = load();
  const isFirst = !state.installReported;
  const params = new URLSearchParams({ v: pkg.version, os: coarseOsTag() });
  if (isFirst) params.set("new", "1");
  try {
    const res = await fetch(`${PING_URL}?${params.toString()}`, {
      headers: { "X-Install-Id": getInstallId(), "user-agent": `redesign/${pkg.version}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    state.lastPingAt = new Date().toISOString();
    if (isFirst) state.installReported = true;
    save(state);
  } catch {
    /* offline, DNS, timeout — never the caller's problem */
  }
}

/**
 * Boot-time ping. Call once from the daemon's startup path; never awaited by the caller, never
 * throws, never blocks startup. No-ops entirely when disabled (see `pingDisabled`) or when the
 * last successful ping is still within `THROTTLE_MS`.
 */
export function pingInstallOnBoot(): void {
  if (pingDisabled()) return;
  const state = load();
  const last = state.lastPingAt ? Date.parse(state.lastPingAt) : Number.NaN;
  if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return;
  void ping();
}

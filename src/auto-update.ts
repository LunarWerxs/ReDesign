/**
 * Auto-update timer, "keep the app current for me, silently".
 *
 * A single daemon-wide timer that, each time it fires, asks the shared updater engine
 * (src/updater.ts → src/updater-engine.mjs) whether a newer commit is on the update remote AND
 * the working tree is clean (`canApply`). If so it applies the update (git pull --ff-only +
 * npm install + npm run build, see src/updater.ts) and then SELF-RELAUNCHES so the freshly-pulled
 * code takes over. RēDesign has no separate tray supervisor process, but a plain `redesign serve`
 * foreground process still needs someone to spawn its successor before it exits, the concrete
 * relaunch (spawn a detached copy of our launch command, then gracefully shut down) is injected
 * from src/cli/lifecycle.ts, which owns the shutdown handle.
 *
 * OPT-IN (cfg.autoUpdate; absent/false = off), it restarts the daemon unattended, so it's never on
 * by default. A dirty working tree is NEVER updated (`canApply` gates it), so uncommitted local
 * work is safe. Timer shape is a self-rescheduling setTimeout (never setInterval) so a slow apply
 * can't stack. Primed + toggled live from src/http/app.ts + the settings route; started/stopped in
 * src/cli/lifecycle.ts.
 */
import { recordPulse } from "./http/routes/bootstrap";
import { checkForUpdate, applyUpdate } from "./updater";

/** Check cadence bounds (seconds): 15 min floor, 7 day ceiling, default 6 h. */
export const AUTO_UPDATE_INTERVAL_MIN_S = 900;
export const AUTO_UPDATE_INTERVAL_MAX_S = 604_800;
export const AUTO_UPDATE_INTERVAL_DEFAULT_S = 21_600;

/** Clamp a requested cadence into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampAutoUpdateInterval(secs: number): number {
  if (!Number.isFinite(secs)) return AUTO_UPDATE_INTERVAL_DEFAULT_S;
  return Math.min(AUTO_UPDATE_INTERVAL_MAX_S, Math.max(AUTO_UPDATE_INTERVAL_MIN_S, Math.round(secs)));
}

// ── injectable side-effects (real impls by default; lifecycle wires `relaunch`, tests swap all) ──
export interface AutoUpdateHooks {
  check: typeof checkForUpdate;
  apply: typeof applyUpdate;
  /** Restart the daemon so the freshly-pulled code takes over. Wired by src/cli/lifecycle.ts. */
  relaunch: () => void;
}
function defaultRelaunch(): void {
  // No relaunch handler wired (e.g. createApp() in a test), the update is applied on disk and takes
  // effect on the next manual restart. Never exit here; we don't own a successor.
  console.warn("redesign: auto-update applied, but no relaunch handler is wired, restart to apply the new code.");
}
const realHooks: AutoUpdateHooks = { check: checkForUpdate, apply: applyUpdate, relaunch: defaultRelaunch };
let hooks: AutoUpdateHooks = realHooks;
/** Override the side-effect hooks (lifecycle sets `relaunch`; tests inject fakes for all three so
 *  nothing pulls/spawns/exits). Passing `{}` restores the real hooks. */
export function setAutoUpdateHooks(h: Partial<AutoUpdateHooks>): void {
  hooks = { ...realHooks, ...h };
}

// ── runtime state (mirrors persisted autoUpdate settings; primed at boot, toggled via the settings route) ──
let enabled = false; // OFF by default, it restarts the daemon → opt-in
let intervalSecs = AUTO_UPDATE_INTERVAL_DEFAULT_S;
let started = false; // true only after the daemon finishes booting (startAutoUpdate)
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let applying = false; // an apply is in flight, never overlap checks/applies

export function autoUpdateEnabled(): boolean {
  return enabled;
}
export function getAutoUpdateIntervalSecs(): number {
  return intervalSecs;
}

/** Outcome of one check→apply→relaunch pass. Returned (not just logged) so it's unit-testable. */
export interface AutoUpdateRunResult {
  checked: boolean;
  applied: boolean;
  relaunched: boolean;
  reason?: string;
}

/**
 * One check → maybe apply → maybe relaunch. Applies ONLY when the engine reports an update is
 * available AND applicable (`canApply`: clean tree, on a branch with an update remote), so a dirty
 * working tree is never touched. On a successful apply that needs a restart, it fires the injected
 * relaunch. Exported + returns a result so the timer AND the test can drive it identically.
 */
export async function runAutoUpdateOnce(): Promise<AutoUpdateRunResult> {
  if (applying) return { checked: false, applied: false, relaunched: false, reason: "busy" };
  let status: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    status = await hooks.check();
  } catch {
    return { checked: false, applied: false, relaunched: false, reason: "check-failed" };
  }
  if (!status.ok) return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "check-error" };
  if (!status.updateAvailable) return { checked: true, applied: false, relaunched: false, reason: "up-to-date" };
  // Hard gate: canApply is false on a dirty tree / detached HEAD / no update remote, never update then.
  if (!status.canApply) return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "cannot-apply" };

  applying = true;
  try {
    void recordPulse("auto_update_applying", { from: status.currentCommit, to: status.remoteCommit });
    const res = await hooks.apply();
    if (!res.ok) return { checked: true, applied: false, relaunched: false, reason: "apply-failed" };
    if (res.restartRequired) {
      void recordPulse("auto_update_restarting", { message: res.message });
      hooks.relaunch();
      return { checked: true, applied: true, relaunched: true };
    }
    return { checked: true, applied: true, relaunched: false };
  } catch {
    return { checked: true, applied: false, relaunched: false, reason: "apply-threw" };
  } finally {
    applying = false;
  }
}

// ── timer plumbing (mirrors RepoYeti's auto-commit.ts / auto-update.ts) ──────────────────────────
function schedule(): void {
  timer = setTimeout(() => void runTick(), intervalSecs * 1000);
}
async function runTick(): Promise<void> {
  timer = null;
  ticking = true;
  try {
    await runAutoUpdateOnce();
  } catch {
    /* a round failing is non-fatal, we just try again next window */
  } finally {
    ticking = false;
  }
  if (started && enabled && !timer) schedule();
}
/** Bring the timer in line with the current enabled/started state (idempotent). */
function reconcile(): void {
  if (!started) return;
  if (enabled && !timer && !ticking) schedule();
  else if (!enabled && timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Re-arm a running loop with the current cadence (no-op when idle or mid-tick). */
function retime(): void {
  if (started && enabled && !ticking) {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }
}

/** Begin the loop once the daemon has booted (src/cli/lifecycle.ts). The first check is one interval
 *  out (never in the boot stampede, so a fresh launch is never interrupted by an immediate restart).
 *  No-op beyond arming when auto-update is disabled. */
export function startAutoUpdate(): void {
  started = true;
  reconcile();
}
/** Stop the loop (daemon shutdown). Safe to call when it was never started. */
export function stopAutoUpdate(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Enable/disable (persisted setting at boot + the settings route). Starts/stops the timer live. */
export function setAutoUpdateEnabled(value: boolean): void {
  enabled = value;
  reconcile();
}
/** Set the check cadence in seconds (clamped). Re-times a running loop. Returns the clamped value. */
export function setAutoUpdateIntervalSecs(secs: number): number {
  intervalSecs = clampAutoUpdateInterval(secs);
  retime();
  return intervalSecs;
}

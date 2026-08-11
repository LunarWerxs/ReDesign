/**
 * Auto-update timer, "keep the app current for me, without restarting it out from under me".
 *
 * A single daemon-wide timer asks src/updater.ts whether a newer version is available and
 * applicable. Source checkouts fast-forward/rebuild; compiled releases download and verify the
 * compressed platform archive. When auto-apply is on, it then SELF-RELAUNCHES so the updated
 * code takes over. RēDesign has no separate tray supervisor process, but a plain `redesign serve`
 * foreground process still needs someone to spawn its successor before it exits, the concrete
 * relaunch (spawn a detached copy of our launch command, then gracefully shut down) is injected
 * from src/cli/lifecycle.ts, which owns the shutdown handle.
 *
 * TWO settings share this one timer, because they need the same check and differ only in what
 * happens next:
 *   · cfg.updateNotify (absent = ON)  — announce an available update (src/bus.ts's
 *     "update_available", forwarded to the browser over GET /api/events) and let the owner
 *     decide. Nothing is installed.
 *   · cfg.autoUpdate   (absent = OFF since 2026-08-11) — additionally APPLY it and self-relaunch,
 *     unattended. Only an explicit `true` opts in; an explicit `false` stays fully off.
 * Those are different consents: being told you're out of date costs nothing, whereas restarting
 * the daemon out from under whoever is using it is a thing you opt into. So the timer runs when
 * EITHER is on, and only the second one ever applies anything.
 *
 * A dirty source tree is NEVER updated (`canApply` gates it), so uncommitted local work is safe,
 * and a restart never interrupts an active run (see `restartPending`). Timer shape is a
 * self-rescheduling setTimeout (never setInterval) so a slow apply can't stack. Primed + toggled
 * live from src/http/app.ts + the settings route; started/stopped in src/cli/lifecycle.ts.
 */
import { hasActiveRun } from "./http/runQueue";
import { broadcast } from "./bus";
import { applyUpdate, checkForUpdate } from "./updater";

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

// ── runtime state (mirrors persisted settings; primed at boot, toggled via the settings route) ──
let enabled = false; // silent auto-apply: OFF by default (2026-08-11); only an explicit `autoUpdate: true` turns it on
let notifyEnabled = true; // notify-only: ON by default; only an explicit `updateNotify: false` turns it off
let intervalSecs = AUTO_UPDATE_INTERVAL_DEFAULT_S;
let started = false; // true only after the daemon finishes booting (startAutoUpdate)
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let applying = false; // an apply is in flight, never overlap checks/applies
// An update was applied on disk but its relaunch was deferred because a run was active
// at the time. Never restart out from under a running job; the next tick (or an explicit
// nudge from runQueue once a run finishes) retries the relaunch once idle.
let restartPending = false;

export function autoUpdateEnabled(): boolean {
  return enabled;
}
export function updateNotifyEnabled(): boolean {
  return notifyEnabled;
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

/** True if an update was applied on disk but its restart is waiting for the app to go idle. */
export function isRestartPending(): boolean {
  return restartPending;
}

/** Fire the deferred relaunch now, if one is pending and no run is active. Safe to call
 *  speculatively (e.g. from runQueue.ts right after a run finishes); no-ops otherwise. */
export function maybeApplyDeferredRestart(): boolean {
  if (!restartPending || hasActiveRun()) return false;
  restartPending = false;
  hooks.relaunch();
  return true;
}

/**
 * One check → maybe notify → maybe apply → maybe relaunch. Applies ONLY when auto-apply is on AND
 * the engine reports an update is available AND applicable (`canApply`: clean tree, on a branch
 * with an update remote), so a dirty working tree is never touched. On a successful apply that
 * needs a restart, it fires the injected relaunch UNLESS a run is actively queued/running, in
 * which case the restart is deferred until the app goes idle (see
 * `maybeApplyDeferredRestart`/`restartPending`); a run in progress is never interrupted by a
 * self-relaunch. Exported + returns a result so the timer AND the test can drive it identically.
 */
export async function runAutoUpdateOnce(): Promise<AutoUpdateRunResult> {
  if (applying) return { checked: false, applied: false, relaunched: false, reason: "busy" };

  // A previous pass already applied an update but deferred the restart, retry the relaunch now
  // instead of re-checking/re-applying (nothing new to fetch; we're just waiting to go idle).
  if (restartPending) {
    if (hasActiveRun()) return { checked: false, applied: false, relaunched: false, reason: "deferred-active-run" };
    maybeApplyDeferredRestart();
    return { checked: false, applied: true, relaunched: true };
  }

  let status: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    status = await hooks.check();
  } catch {
    return { checked: false, applied: false, relaunched: false, reason: "check-failed" };
  }
  if (!status.ok) return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "check-error" };
  if (!status.updateAvailable) return { checked: true, applied: false, relaunched: false, reason: "up-to-date" };

  // An update exists. Unless the owner opted into silent installs (`enabled`), this is where it
  // stops: say so (if notify is on) and let them choose via the UI's "Update now". Announced even
  // when `canApply` is false (dirty tree) — "an update is waiting, commit your work to take it" is
  // exactly the useful thing to know at that moment, and the UI shows the reason.
  if (!enabled) {
    if (notifyEnabled) {
      broadcast("update_available", {
        from: status.currentCommit,
        to: status.remoteCommit,
        canApply: status.canApply,
        reason: status.reason ?? null,
      });
      return { checked: true, applied: false, relaunched: false, reason: "notified" };
    }
    return { checked: true, applied: false, relaunched: false, reason: "notify-off" };
  }

  // Hard gate: canApply is false on a dirty tree / detached HEAD / no update remote, never update then.
  if (!status.canApply) {
    // Still worth announcing: an update is waiting and something (usually a dirty tree) is in
    // the way, which is the owner's to resolve — auto-apply being on doesn't mean silence here.
    if (notifyEnabled) {
      broadcast("update_available", {
        from: status.currentCommit,
        to: status.remoteCommit,
        canApply: false,
        reason: status.reason ?? null,
      });
    }
    return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "cannot-apply" };
  }

  applying = true;
  try {
    const res = await hooks.apply();
    if (!res.ok) return { checked: true, applied: false, relaunched: false, reason: "apply-failed" };
    if (res.restartRequired) {
      // Never restart out from under an active run; defer and retry once idle.
      if (hasActiveRun()) {
        restartPending = true;
        return { checked: true, applied: true, relaunched: false, reason: "deferred-active-run" };
      }
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
// The timer runs whenever EITHER setting wants a check — notify-only still needs the periodic
// check to have anything to announce (spec: the check runs regardless of the auto-apply setting).
function wantsTimer(): boolean {
  return enabled || notifyEnabled;
}
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
  if (started && wantsTimer() && !timer) schedule();
}
/** Bring the timer in line with the current enabled/notifyEnabled/started state (idempotent). */
function reconcile(): void {
  if (!started) return;
  if (wantsTimer() && !timer && !ticking) schedule();
  else if (!wantsTimer() && timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Re-arm a running loop with the current cadence (no-op when idle or mid-tick). */
function retime(): void {
  if (started && wantsTimer() && !ticking) {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }
}

/** Begin the loop once the daemon has booted (src/cli/lifecycle.ts). The first check is one interval
 *  out (never in the boot stampede, so a fresh launch is never interrupted by an immediate restart).
 *  No-op beyond arming when both auto-update and notify are disabled. */
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
/** Enable/disable silent auto-apply (persisted setting at boot + the settings route). Starts/stops
 *  the timer live (it may already be running for notify-only, in which case this is a no-op on
 *  the timer itself). */
export function setAutoUpdateEnabled(value: boolean): void {
  enabled = value;
  reconcile();
}
/** Enable/disable "tell me about updates" (persisted setting at boot + the settings route).
 *  Starts/stops the timer live, same as `setAutoUpdateEnabled`. */
export function setUpdateNotifyEnabled(value: boolean): void {
  notifyEnabled = value;
  reconcile();
}
/** Set the check cadence in seconds (clamped). Re-times a running loop. Returns the clamped value. */
export function setAutoUpdateIntervalSecs(secs: number): number {
  intervalSecs = clampAutoUpdateInterval(secs);
  retime();
  return intervalSecs;
}

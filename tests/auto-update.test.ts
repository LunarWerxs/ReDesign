import { test, expect, afterEach } from "bun:test";
import {
  runAutoUpdateOnce,
  setAutoUpdateHooks,
  setAutoUpdateEnabled,
  setUpdateNotifyEnabled,
  autoUpdateEnabled,
  updateNotifyEnabled,
  stopAutoUpdate,
  clampAutoUpdateInterval,
  AUTO_UPDATE_INTERVAL_MIN_S,
  AUTO_UPDATE_INTERVAL_MAX_S,
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
} from "../src/auto-update";
import { addListener, removeListener, type BusListener } from "../src/bus";
import type { UpdateStatus, UpdateApplyResult } from "../src/updater-engine.mjs";

// The auto-update orchestrator's decision logic, driven through injected hooks so nothing actually
// pulls git / spawns / exits. Gates applying strictly on auto-apply being on, updateAvailable, AND
// canApply; only relaunches after a successful apply that reports restartRequired. Also covers the
// notify path: the check always runs, and when auto-apply is off it announces over src/bus.ts
// instead (or stays silent if notify is off too).

// Reset the module's hooks + timer state after each case so they don't bleed across tests.
afterEach(() => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true);
  stopAutoUpdate();
  setAutoUpdateHooks({}); // restore the real hooks
});

/** Subscribe to src/bus.ts for the duration of one assertion; returns what it captured. */
function captureBroadcasts(): { events: Record<string, unknown>[]; stop: () => void } {
  const events: Record<string, unknown>[] = [];
  const listener: BusListener = (payload) => events.push(JSON.parse(payload));
  addListener(listener);
  return { events, stop: () => removeListener(listener) };
}

// A full UpdateStatus with sensible defaults; overrides tweak the fields under test.
function status(over: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: "redesign",
    currentVersion: "0.1.0",
    currentCommit: "aaaa",
    remoteCommit: "bbbb",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
function applyResult(over: Partial<UpdateApplyResult>): UpdateApplyResult {
  return { ok: true, message: "updated", restartRequired: true, status: status({}), output: [], ...over };
}

test("applies + relaunches when an update is available and applicable", async () => {
  setAutoUpdateEnabled(true); // OFF by default since 2026-08-11; this is the opt-in path
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: true });
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(applied).toBe(1);
  expect(relaunched).toBe(1);
});

test("does nothing when already up to date", async () => {
  let applied = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("up-to-date");
  expect(applied).toBe(0);
});

test("never applies on a dirty tree (canApply false)", async () => {
  setAutoUpdateEnabled(true); // exercising the auto-apply gate itself, not the notify-off short-circuit
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () =>
      status({ updateAvailable: true, canApply: false, dirty: true, reason: "local changes must be committed or stashed before updating" }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("does not relaunch when the apply fails", async () => {
  setAutoUpdateEnabled(true);
  let relaunched = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({ ok: false, message: "build failed" }),
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  expect(relaunched).toBe(0);
});

// ── notify path (spec: the check always runs; when auto-apply is off, notify announces instead) ──

test("auto-apply OFF (the default) + notify ON: announces over the bus instead of applying", async () => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true);
  let applied = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true, currentCommit: "aaaa", remoteCommit: "bbbb" }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const cap = captureBroadcasts();
  const r = await runAutoUpdateOnce();
  cap.stop();

  expect(r.applied).toBe(false);
  expect(r.reason).toBe("notified");
  expect(applied).toBe(0);
  expect(cap.events).toEqual([{ type: "update_available", from: "aaaa", to: "bbbb", canApply: true, reason: null }]);
});

test("auto-apply OFF + notify OFF: stays silent (no broadcast, nothing applied)", async () => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(false);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const cap = captureBroadcasts();
  const r = await runAutoUpdateOnce();
  cap.stop();

  expect(r.applied).toBe(false);
  expect(r.reason).toBe("notify-off");
  expect(cap.events).toHaveLength(0);
});

test("notify still fires when nothing is available to announce (up-to-date short-circuits first)", async () => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const cap = captureBroadcasts();
  const r = await runAutoUpdateOnce();
  cap.stop();

  expect(r.reason).toBe("up-to-date");
  expect(cap.events).toHaveLength(0);
});

test("auto-apply ON but blocked (dirty tree) still announces when notify is on", async () => {
  setAutoUpdateEnabled(true);
  setUpdateNotifyEnabled(true);
  let applied = 0;
  setAutoUpdateHooks({
    check: async () =>
      status({
        updateAvailable: true,
        canApply: false,
        dirty: true,
        currentCommit: "aaaa",
        remoteCommit: "bbbb",
        reason: "local changes must be committed or stashed before updating",
      }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const cap = captureBroadcasts();
  const r = await runAutoUpdateOnce();
  cap.stop();

  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(r.reason).toBe("local changes must be committed or stashed before updating");
  expect(cap.events).toEqual([
    {
      type: "update_available",
      from: "aaaa",
      to: "bbbb",
      canApply: false,
      reason: "local changes must be committed or stashed before updating",
    },
  ]);
});

test("updateNotifyEnabled()/autoUpdateEnabled() reflect their setters independently", () => {
  setAutoUpdateEnabled(true);
  setUpdateNotifyEnabled(false);
  expect(autoUpdateEnabled()).toBe(true);
  expect(updateNotifyEnabled()).toBe(false);

  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true);
  expect(autoUpdateEnabled()).toBe(false);
  expect(updateNotifyEnabled()).toBe(true);
});

test("reports the reason when the check itself fails", async () => {
  setAutoUpdateHooks({
    check: async () => status({ ok: false, reason: "no update remote configured" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("no update remote configured");
});

test("clampAutoUpdateInterval bounds the cadence", () => {
  expect(clampAutoUpdateInterval(10)).toBe(AUTO_UPDATE_INTERVAL_MIN_S);
  expect(clampAutoUpdateInterval(9_999_999)).toBe(AUTO_UPDATE_INTERVAL_MAX_S);
  expect(clampAutoUpdateInterval(Number.NaN)).toBe(AUTO_UPDATE_INTERVAL_DEFAULT_S);
  expect(clampAutoUpdateInterval(3600)).toBe(3600);
});

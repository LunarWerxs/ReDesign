// Characterization tests for src/cli/lifecycle.ts's `serveCmd` — the function the complexity gate
// names (`src/cli/lifecycle.ts:162`, cognitive=30). They were written and run BEFORE the extraction
// that closed that finding, against the file unchanged, so every assertion below describes behaviour
// that already existed; the refactor is only allowed to keep them green.
//
// serveCmd's real boot is not reachable from a test: src/http/serve.ts's startServer() binds a real
// socket, materializes the tray toolkit, spawns the tray host, and its shutdown() ends in
// process.exit(0). So every collaborator serveCmd fans out to is mocked with bun:test's
// mock.module (the technique tests/routes-smoke.test.ts documents) and the tests pin the
// ORCHESTRATION instead: which branch runs, in what order, what it prints, what env it reads and
// writes, and what it passes to each collaborator. That is exactly the surface the extraction moves.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Args } from "../src/cli/args";

// ── collaborators, all mocked ────────────────────────────────────────────────────────────────────
const calls: string[] = [];

let pingCalls = 0;

// The single-instance guard's two halves.
let liveInstance: { url: string } | null = null;
let liveInstanceAt: { url: string } | null = null;
let liveInstanceAtArgs: [string, number | undefined][] = [];
let lockResult: { release(): void } | null = null;
let acquireCalls = 0;
let acquireArgs: string[] = [];
let releaseCalls = 0;

let openUiCalls: string[] = [];
let openUiResult = true;

let startServerCalls = 0;
let startServerResult: { port?: number } = { port: 6123 };

let shutdownCalls = 0;
let hooks: { relaunch?: () => void } | null = null;
let startAutoUpdateCalls = 0;

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  unref: () => void;
  unrefCalled: boolean;
}
let spawnCalls: SpawnCall[] = [];
let spawnThrows = false;

const realChildProcess = { ...(await import("node:child_process")) };
const realInstance = { ...(await import("../src/instance")) };
const realLaunchLock = { ...(await import("../src/launch-lock")) };
const realOpenUi = { ...(await import("../src/open-ui")) };
const realInstallPing = { ...(await import("../src/install-ping")) };
const realAutoUpdate = { ...(await import("../src/auto-update")) };
const realServe = { ...(await import("../src/http/serve")) };

mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    if (spawnThrows) throw new Error("spawn refused");
    const call: SpawnCall = { command, args, options, unrefCalled: false, unref: () => {} };
    call.unref = () => {
      call.unrefCalled = true;
    };
    spawnCalls.push(call);
    return call;
  },
}));

mock.module("../src/instance", () => ({
  ...realInstance,
  findLiveInstance: async () => {
    calls.push("findLiveInstance");
    return liveInstance;
  },
  findLiveInstanceAt: async (base: string, timeoutMs?: number) => {
    calls.push("findLiveInstanceAt");
    liveInstanceAtArgs.push([base, timeoutMs]);
    return liveInstanceAt;
  },
}));

mock.module("../src/launch-lock", () => ({
  ...realLaunchLock,
  acquireLaunchLock: (dir: string) => {
    calls.push("acquireLaunchLock");
    acquireCalls++;
    acquireArgs.push(dir);
    return lockResult;
  },
}));

mock.module("../src/open-ui", () => ({
  ...realOpenUi,
  openUi: (url: string) => {
    calls.push("openUi");
    openUiCalls.push(url);
    return openUiResult;
  },
}));

mock.module("../src/install-ping", () => ({
  ...realInstallPing,
  pingInstallOnBoot: () => {
    calls.push("pingInstallOnBoot");
    pingCalls++;
  },
}));

mock.module("../src/auto-update", () => ({
  ...realAutoUpdate,
  setAutoUpdateHooks: (h: { relaunch?: () => void }) => {
    calls.push("setAutoUpdateHooks");
    hooks = h;
  },
  startAutoUpdate: () => {
    calls.push("startAutoUpdate");
    startAutoUpdateCalls++;
  },
}));

mock.module("../src/http/serve", () => ({
  ...realServe,
  startServer: async () => {
    calls.push("startServer");
    startServerCalls++;
    return startServerResult;
  },
  shutdown: () => {
    calls.push("shutdown");
    shutdownCalls++;
  },
}));

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
  mock.module("../src/instance", () => realInstance);
  mock.module("../src/launch-lock", () => realLaunchLock);
  mock.module("../src/open-ui", () => realOpenUi);
  mock.module("../src/install-ping", () => realInstallPing);
  mock.module("../src/auto-update", () => realAutoUpdate);
  mock.module("../src/http/serve", () => realServe);
});

// Deliberately still a dynamic import: it must resolve AFTER the mock.module calls above.
const { serveCmd } = await import("../src/cli/lifecycle");

// ── harness ──────────────────────────────────────────────────────────────────────────────────────
const ENV_KEYS = ["PORT", "HOST", "REDESIGN_RELAUNCH", "REDESIGN_PORT_FIXED"] as const;
let savedEnv: Record<string, string | undefined> = {};
let logged: string[] = [];
let errored: string[] = [];
const realLog = console.log;
const realError = console.error;

function args(extra: Record<string, unknown> = {}): Args {
  return { _: [], ...extra } as Args;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];

  calls.length = 0;
  pingCalls = 0;
  liveInstance = null;
  liveInstanceAt = null;
  liveInstanceAtArgs = [];
  lockResult = null;
  acquireCalls = 0;
  acquireArgs = [];
  releaseCalls = 0;
  openUiCalls = [];
  openUiResult = true;
  startServerCalls = 0;
  startServerResult = { port: 6123 };
  shutdownCalls = 0;
  hooks = null;
  startAutoUpdateCalls = 0;
  spawnCalls = [];
  spawnThrows = false;
  logged = [];
  errored = [];
  console.log = ((...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
  }) as typeof console.log;
  console.error = ((...a: unknown[]) => {
    errored.push(a.map(String).join(" "));
  }) as typeof console.error;
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A launch-lock the guard acquired on this process's behalf. */
function heldLock(): { release(): void } {
  return {
    release() {
      calls.push("release");
      releaseCalls++;
    },
  };
}

const prints = (needle: string) => logged.some((line) => line.includes(needle));

// ── the single-instance guard ────────────────────────────────────────────────────────────────────
describe("serveCmd single-instance guard", () => {
  test("another launcher holds the gate and nothing is live: says so and returns without booting", async () => {
    lockResult = null; // acquireLaunchLock refused
    await serveCmd(args());

    expect(acquireCalls).toBe(1);
    expect(prints("already starting")).toBe(true);
    expect(prints("already running")).toBe(false);
    expect(openUiCalls).toEqual([]);
    expect(startServerCalls).toBe(0);
    expect(startAutoUpdateCalls).toBe(0);
    expect(hooks).toBeNull();
  });

  test("another launcher holds the gate but a daemon is live: reports its URL and opens it", async () => {
    lockResult = null;
    liveInstance = { url: "http://127.0.0.1:4444" };
    await serveCmd(args({ openUi: true }));

    expect(prints("already running")).toBe(true);
    expect(prints("already starting")).toBe(false);
    expect(openUiCalls).toEqual(["http://127.0.0.1:4444"]);
    expect(startServerCalls).toBe(0);
  });

  test("the gate is taken but a daemon is live, the direct-probe fallback finds it: releases the gate, no boot", async () => {
    lockResult = heldLock();
    liveInstance = null; // pointer probe misses
    liveInstanceAt = { url: "http://127.0.0.1:5199" }; // port probe finds it
    await serveCmd(args());

    expect(releaseCalls).toBe(1);
    expect(prints("already running")).toBe(true);
    expect(startServerCalls).toBe(0);
    expect(startAutoUpdateCalls).toBe(0);
  });

  test("nothing is live: keeps the gate, boots, and releases it once the server is up", async () => {
    lockResult = heldLock();
    await serveCmd(args());

    expect(acquireCalls).toBe(1);
    expect(prints("already running")).toBe(false);
    expect(startServerCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(startAutoUpdateCalls).toBe(1);
    // startServer must run before the gate is released.
    expect(calls.indexOf("startServer")).toBeLessThan(calls.indexOf("release"));
  });

  test("REDESIGN_PORT_FIXED=1 is exempt: the gate is never consulted, even with a daemon live", async () => {
    process.env.REDESIGN_PORT_FIXED = "1";
    liveInstance = { url: "http://127.0.0.1:4444" };
    await serveCmd(args());

    expect(acquireCalls).toBe(0);
    expect(prints("already running")).toBe(false);
    expect(startServerCalls).toBe(1);
  });

  test("REDESIGN_RELAUNCH=1 is exempt: the gate is never consulted", async () => {
    process.env.REDESIGN_RELAUNCH = "1";
    liveInstance = { url: "http://127.0.0.1:4444" };
    await serveCmd(args());

    expect(acquireCalls).toBe(0);
    expect(startServerCalls).toBe(1);
  });

  test("args.port/args.host/args.relaunch are applied to the environment before the guard probes", async () => {
    lockResult = null;
    await serveCmd(args({ port: 5301, host: "127.0.0.9", relaunch: true }));

    expect(process.env.PORT).toBe("5301");
    expect(process.env.HOST).toBe("127.0.0.9");
    expect(process.env.REDESIGN_RELAUNCH).toBe("1");
    // --relaunch also trips the exemption, so the guard never ran.
    expect(acquireCalls).toBe(0);
    // The direct-probe fallback is not reached on the exempt path.
    expect(liveInstanceAtArgs).toEqual([]);
  });

  test("the fallback probe uses the port the caller asked for", async () => {
    lockResult = null;
    liveInstance = null;
    await serveCmd(args({ port: 5302 }));

    expect(liveInstanceAtArgs).toEqual([["http://127.0.0.1:5302", 1000]]);
  });
});

// ── boot: port resolution + opening the UI ──────────────────────────────────────────────────────
describe("serveCmd boot", () => {
  test("opens the UI at the port the server actually bound", async () => {
    lockResult = heldLock();
    startServerResult = { port: 6123 };
    await serveCmd(args({ openUi: true }));

    expect(openUiCalls).toEqual(["http://127.0.0.1:6123/"]);
    // The ping is fire-and-forget but always fired, before anything else.
    expect(pingCalls).toBe(1);
    expect(calls.indexOf("pingInstallOnBoot")).toBe(0);
  });

  test("falls back to PORT when Bun.serve reports no port", async () => {
    lockResult = heldLock();
    startServerResult = {};
    await serveCmd(args({ port: 5303, openUi: true }));

    expect(openUiCalls).toEqual(["http://127.0.0.1:5303/"]);
  });

  test("warns when the browser could not be opened, and does not when it could", async () => {
    lockResult = heldLock();
    openUiResult = false;
    await serveCmd(args({ openUi: true }));
    expect(errored.some((line) => line.includes("Could not open a browser"))).toBe(true);

    errored = [];
    openUiResult = true;
    await serveCmd(args({ openUi: true }));
    expect(errored).toEqual([]);
  });

  test("does not open a browser without --open-ui", async () => {
    lockResult = heldLock();
    await serveCmd(args());
    expect(openUiCalls).toEqual([]);
  });
});

// ── the auto-update relaunch hook ───────────────────────────────────────────────────────────────
describe("serveCmd auto-update relaunch hook", () => {
  /** Boot far enough that setAutoUpdateHooks has been handed serveCmd's relaunch closure. */
  async function bootAndCaptureRelaunch(port = 6123): Promise<() => void> {
    lockResult = heldLock();
    startServerResult = { port };
    await serveCmd(args());
    expect(hooks?.relaunch).toBeFunction();
    return hooks?.relaunch as () => void;
  }

  test("spawns a detached same-port successor, then shuts this daemon down", async () => {
    // Guard the harness: if the module under test is holding the REAL spawn, invoking the hook
    // would launch a real detached process. Fail here instead.
    const liveChildProcess = await import("node:child_process");
    expect(liveChildProcess.spawn).not.toBe(realChildProcess.spawn);

    const relaunch = await bootAndCaptureRelaunch(6123);
    expect(spawnCalls).toEqual([]);
    relaunch();

    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0] as SpawnCall;
    const isWin = process.platform === "win32";
    expect(call.command).toBe(isWin ? "powershell" : process.execPath);
    // The successor is handed the port we are ACTUALLY serving on, not the preferred one.
    expect((call.options.env as Record<string, string>).PORT).toBe("6123");
    expect((call.options.env as Record<string, string>).REDESIGN_RELAUNCH).toBe("1");
    expect(call.options.stdio).toBe("ignore");
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.cwd).toBe(process.cwd());
    // The shared detached-spawn primitive decides this: powershell on win32, real detach elsewhere.
    expect(call.options.detached).toBe(!isWin);
    expect(call.unrefCalled).toBe(true);

    // The shutdown is deferred, never immediate.
    expect(shutdownCalls).toBe(0);
    await Bun.sleep(950);
    expect(shutdownCalls).toBe(1);
  });

  test("a spawn that throws is reported and never shuts the daemon down", async () => {
    const relaunch = await bootAndCaptureRelaunch();
    spawnThrows = true;
    relaunch();

    expect(spawnCalls).toEqual([]);
    expect(errored.some((line) => line.includes("relaunch failed to spawn"))).toBe(true);
    await Bun.sleep(950);
    expect(shutdownCalls).toBe(0);
  });
});

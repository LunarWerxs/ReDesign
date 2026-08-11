/**
 * Tests for src/install-ping.ts, the anonymous install/usage ping that replaced the dormant
 * REDESIGN_PULSE_URL-gated `recordPulse` mechanism (see that file's header for the full story).
 *
 * Snapshots/restores output/.reimagine-state.json around every test (same pattern as
 * tests/app-settings.test.ts), and stubs the process-global `fetch` (same pattern as
 * tests/connections.test.ts) so nothing here ever reaches the real network. `NODE_ENV` is "test"
 * throughout a `bun test` run (see tests/setup.ts's preload), which is itself one of the ping's
 * opt-out gates, so exercising the "enabled" path means temporarily unsetting it. The ping is
 * also gated on util.ts's `IS_PACKAGED` (never pings from a source checkout / dev mode), which
 * `bun test` always runs under, so the "enabled" path additionally fakes that `true` via
 * `mock.module` (same technique as tests/settings.test.ts).
 */
import { test, expect, afterEach, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/util";
import { coarseOsTag, getInstallId, PING_URL, pingInstallOnBoot } from "../src/install-ping";

// pingDisabled() also gates on util.ts's IS_PACKAGED (a compiled/packaged run, never a source
// checkout), the same dev-detection idiom tests/settings.test.ts already mocks this way: a plain
// snapshot taken before mocking, restored after, since mock.module mutates the live "../src/util"
// namespace in place (so it retroactively affects install-ping.ts's already-bound import too).
const realUtilLive = await import("../src/util");
const realUtilSnapshot = { ...realUtilLive };

const STATE_FILE = path.join(ROOT, "output", ".reimagine-state.json");

const existed = fs.existsSync(STATE_FILE);
const before = existed ? fs.readFileSync(STATE_FILE, "utf8") : null;

afterEach(() => {
  if (before !== null) {
    fs.writeFileSync(STATE_FILE, before);
  } else if (fs.existsSync(STATE_FILE)) {
    fs.rmSync(STATE_FILE, { force: true });
  }
});

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

interface Sent {
  url: string;
  headers: Record<string, string>;
}

/** Run `fn` with NODE_ENV/CI/REDESIGN_NO_PING cleared and IS_PACKAGED faked `true` (so the ping is
 *  actually enabled, as if this were a real packaged install rather than the `bun test` source
 *  checkout it actually is) and a captured `fetch`, restoring the env, the util mock, and the real
 *  fetch afterwards. */
async function withPingEnabled(
  respond: (() => Response) | "throw",
  fn: (sent: Sent[]) => Promise<void> | void,
): Promise<void> {
  const keys = ["NODE_ENV", "BUN_ENV", "CI", "REDESIGN_NO_PING"] as const;
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  mock.module("../src/util", () => ({ ...realUtilSnapshot, IS_PACKAGED: true }));

  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(PING_URL)) return realFetch(input as RequestInfo, init);
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (respond === "throw") throw new Error("ping endpoint unreachable");
    return respond();
  }) as typeof fetch;

  try {
    await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
    mock.module("../src/util", () => realUtilSnapshot);
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("coarseOsTag returns a coarse, non-identifying tag", () => {
  const tag = coarseOsTag();
  expect(["win11", "win10", "macos", "linux", process.platform]).toContain(tag);
  // Never leaks the exact kernel/build string.
  expect(tag).not.toMatch(/\d+\.\d+\.\d+/);
});

test("getInstallId mints a random id once and persists it across calls", () => {
  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE, { force: true });
  const first = getInstallId();
  const second = getInstallId();
  expect(first).toBe(second);
  expect(first.length).toBeGreaterThan(10);
  expect(readState().installId).toBe(first);
});

test("REDESIGN_NO_PING=1 keeps the boot ping fully inert", async () => {
  await withPingEnabled(() => new Response("{}"), async (sent) => {
    process.env.REDESIGN_NO_PING = "1";
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent).toEqual([]);
  });
});

test("a fresh install's first ping carries X-Install-Id, ?v=&os=, and &new=1", async () => {
  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE, { force: true });
  await withPingEnabled(() => new Response("{}", { status: 200 }), async (sent) => {
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent.length).toBe(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin + url.pathname).toBe(PING_URL);
    expect(url.searchParams.get("v")).toBeTruthy();
    expect(url.searchParams.get("os")).toBeTruthy();
    expect(url.searchParams.get("new")).toBe("1");
    expect(sent[0]!.headers["x-install-id"]).toBeTruthy();
    expect(readState().installReported).toBe(true);
    expect(readState().lastPingAt).toBeTruthy();
  });
});

test("a later boot ping never repeats &new=1 once the install has been reported", async () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ installId: "existing-install", installReported: true, lastPingAt: "2020-01-01T00:00:00.000Z" }),
  );
  await withPingEnabled(() => new Response("{}", { status: 200 }), async (sent) => {
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent.length).toBe(1);
    const url = new URL(sent[0]!.url);
    expect(url.searchParams.has("new")).toBe(false);
  });
});

test("the boot ping is throttled to at most once per 24h", async () => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ installId: "existing-install", installReported: true, lastPingAt: new Date().toISOString() }),
  );
  await withPingEnabled(() => new Response("{}", { status: 200 }), async (sent) => {
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent).toEqual([]); // last ping was seconds ago, well inside the 24h floor
  });
});

test("a source checkout (IS_PACKAGED false) never pings, even with every other gate cleared", async () => {
  await withPingEnabled(() => new Response("{}", { status: 200 }), async (sent) => {
    // withPingEnabled fakes IS_PACKAGED true; override it back to the real dev-mode value here to
    // prove the boot ping is inert on a from-source run regardless of the other opt-out env vars.
    mock.module("../src/util", () => ({ ...realUtilSnapshot, IS_PACKAGED: false }));
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent).toEqual([]);
  });
});

test("a failed ping never marks the install as reported (so it retries next time)", async () => {
  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE, { force: true });
  await withPingEnabled("throw", async (sent) => {
    pingInstallOnBoot();
    await Bun.sleep(10);
    expect(sent.length).toBe(1);
    const onDisk = fs.existsSync(STATE_FILE) ? readState() : {};
    expect(onDisk.installReported).not.toBe(true);
    expect(onDisk.lastPingAt).toBeUndefined();
  });
});

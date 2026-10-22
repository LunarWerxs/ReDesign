// Coverage for src/server/settings.ts's .env-rewriting key CRUD: setEnvKeyPool (the on-disk
// line-rewriter) driven through the exported saveApiKey / deleteApiKey / importKeys functions,
// exactly as the real /api/keys/* routes (src/http/routes/keys.ts) call them. This file had ZERO
// coverage before, despite rewriting the on-disk .env that holds every provider's API keys.
//
// ENV_FILE (src/util.ts) resolves to <repoRoot>/.env whenever the app runs from source, which is
// exactly how tests run (see util.ts's IS_PACKAGED check: it only redirects to REDESIGN_HOME when
// packaged). Unlike KeyManager, there is no constructor option to point settings.ts at a different
// file, so calling saveApiKey/deleteApiKey unmodified would rewrite the developer's REAL .env.
//
// This file redirects ENV_FILE with bun:test's mock.module, swapping it for a path inside a
// scratch temp dir before src/server/settings.ts is (re)imported. Verified empirically before
// writing these tests:
//   - mock.module mutates the live module-namespace object for "../src/util" in place, so the
//     redirect takes effect even when another test file (e.g. runQueue.test.ts, which sorts
//     before this file and builds the real app via createApp()) already loaded settings.ts
//     against the real util.ts first.
//   - the mock is process-global and outlives this file unless undone, so afterAll restores it
//     from a plain snapshot object taken *before* mocking (not the live namespace reference,
//     which would already reflect the mocked value by the time afterAll runs).
//   - nothing outside settings.ts reads ENV_FILE (grep confirms), so even without the restore
//     this couldn't affect another test file's outcome; the restore is hygiene, not a fix.
//
// setEnvKeyPool itself isn't exported, so every assertion below drives it indirectly through
// saveApiKey/deleteApiKey/importKeys and asserts on the resulting file content + process.env.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-settings-test-"));
const FAKE_ENV_FILE = path.join(scratchDir, ".env");

const realUtilLive = await import("../src/util");
const realUtilSnapshot = { ...realUtilLive }; // decoupled plain-object copy, not the live namespace

mock.module("../src/util", () => ({ ...realUtilSnapshot, ENV_FILE: FAKE_ENV_FILE }));

const settings = await import("../src/server/settings");
const { keyId } = realUtilSnapshot;

afterAll(() => {
  mock.module("../src/util", () => realUtilSnapshot);
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function writeEnvFile(content: string): void {
  fs.writeFileSync(FAKE_ENV_FILE, content);
}
function readEnvFile(): string {
  return fs.readFileSync(FAKE_ENV_FILE, "utf8");
}
function rmEnvFile(): void {
  fs.rmSync(FAKE_ENV_FILE, { force: true });
}
function scratchDirFiles(): string[] {
  return fs.readdirSync(scratchDir);
}
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | undefined)?.status;
}

// The only pool these tests touch. Every test sets its own process.env value first (never
// depending on tests/setup.ts's seed or on what an earlier test in this file left behind), and
// beforeEach/afterEach snapshot + restore it so nothing leaks into another test file.
const POOL = "ANTHROPIC_API_KEYS";
const POOL_ENV_RE = /^ANTHROPIC_API_KEYS(_\d+)?$/;

let envSnapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  envSnapshot = {};
  for (const k of Object.keys(process.env)) if (POOL_ENV_RE.test(k)) envSnapshot[k] = process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (POOL_ENV_RE.test(k) && !(k in envSnapshot)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmEnvFile();
  for (const f of scratchDirFiles()) fs.rmSync(path.join(scratchDir, f), { force: true });
});

describe("setEnvKeyPool line-rewriting (via saveApiKey/deleteApiKey)", () => {
  it("adds a pool that isn't in the file yet, appended after a blank line", () => {
    process.env[POOL] = "sk-ant-e1,sk-ant-e2";
    writeEnvFile("OTHER_VAR=hello\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e3" });

    expect(readEnvFile()).toBe("OTHER_VAR=hello\n\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2,sk-ant-e3\n");
    expect(process.env[POOL]).toBe("sk-ant-e1,sk-ant-e2,sk-ant-e3");
  });

  it("creates the file from scratch when it doesn't exist yet", () => {
    process.env[POOL] = "";
    delete process.env[POOL];
    rmEnvFile();
    expect(fs.existsSync(FAKE_ENV_FILE)).toBe(false);

    settings.saveApiKey({ pool: POOL, key: "sk-ant-only" });

    expect(readEnvFile()).toBe("ANTHROPIC_API_KEYS=sk-ant-only\n");
  });

  it("replaces an existing pool's line in place, preserving surrounding lines and their order", () => {
    process.env[POOL] = "sk-ant-e1,sk-ant-e2";
    writeEnvFile("A=1\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\nB=2\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e3" });

    expect(readEnvFile()).toBe("A=1\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2,sk-ant-e3\nB=2\n");
  });

  it("collapses pre-existing indexed FOO_1=/FOO_2= lines into one canonical FOO= line", () => {
    process.env[POOL] = "sk-ant-e1"; // only the direct var is set; getKeyPool sees just this one key
    writeEnvFile("X=1\nANTHROPIC_API_KEYS_1=sk-ant-old1\nY=2\nANTHROPIC_API_KEYS_2=sk-ant-old2\nZ=3\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    // Both indexed lines collapse into one FOO= line at the FIRST matched line's position;
    // the second matched line is dropped entirely, not left behind or turned into a duplicate.
    expect(readEnvFile()).toBe("X=1\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\nY=2\nZ=3\n");
  });

  it("`export FOO=` prefixed lines are matched too, and the export keyword is dropped on rewrite", () => {
    process.env[POOL] = "sk-ant-old1,sk-ant-old2";
    writeEnvFile("export ANTHROPIC_API_KEYS=sk-ant-old1,sk-ant-old2\n");
    const oldId2 = keyId("sk-ant-old2");

    settings.deleteApiKey({ pool: POOL, id: oldId2 });

    expect(readEnvFile()).toBe("ANTHROPIC_API_KEYS=sk-ant-old1\n");
    expect(process.env[POOL]).toBe("sk-ant-old1");
  });

  it("preserves CRLF line endings end to end", () => {
    process.env[POOL] = "sk-ant-e1";
    writeEnvFile("A=1\r\nANTHROPIC_API_KEYS=sk-ant-e1\r\nB=2\r\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    expect(readEnvFile()).toBe("A=1\r\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\r\nB=2\r\n");
  });

  it("preserves LF-only line endings end to end (no \\r introduced)", () => {
    process.env[POOL] = "sk-ant-e1";
    writeEnvFile("A=1\nANTHROPIC_API_KEYS=sk-ant-e1\nB=2\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    const content = readEnvFile();
    expect(content).not.toContain("\r");
    expect(content).toBe("A=1\nANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\nB=2\n");
  });

  it("a file with no trailing newline stays without one", () => {
    process.env[POOL] = "sk-ant-e1";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-e1"); // no trailing \n

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    expect(readEnvFile()).toBe("ANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2");
  });

  it("a file with a trailing newline keeps exactly one", () => {
    process.env[POOL] = "sk-ant-e1";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-e1\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    const content = readEnvFile();
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
    expect(content).toBe("ANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\n");
  });

  it("writes atomically (temp file + rename) and leaves no leftover .tmp file", () => {
    process.env[POOL] = "sk-ant-e1";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-e1\n");

    settings.saveApiKey({ pool: POOL, key: "sk-ant-e2" });

    const leftovers = scratchDirFiles().filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(FAKE_ENV_FILE)).toBe(true);
  });

  it("updates process.env to match the write and deletes stale indexed vars", () => {
    delete process.env[POOL];
    process.env.ANTHROPIC_API_KEYS_1 = "sk-ant-idx1";
    process.env.ANTHROPIC_API_KEYS_2 = "sk-ant-idx2";
    rmEnvFile();

    settings.saveApiKey({ pool: POOL, key: "sk-ant-idx3" });

    expect(process.env[POOL]).toBe("sk-ant-idx1,sk-ant-idx2,sk-ant-idx3");
    expect(process.env.ANTHROPIC_API_KEYS_1).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEYS_2).toBeUndefined();
  });
});

describe("saveApiKey / deleteApiKey", () => {
  it("editing an existing key by id replaces its value without changing pool size", () => {
    process.env[POOL] = "sk-ant-e1,sk-ant-e2";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2\n");
    const oldId = keyId("sk-ant-e2");

    const snap = settings.saveApiKey({ pool: POOL, id: oldId, key: "sk-ant-e2-updated" });

    expect(process.env[POOL]).toBe("sk-ant-e1,sk-ant-e2-updated");
    const poolSnap = snap.pools.find((p) => p.pool === POOL);
    expect(poolSnap?.total).toBe(2);
  });

  it("saving a duplicate key value throws 409", () => {
    process.env[POOL] = "sk-ant-e1,sk-ant-e2";
    let caught: unknown;
    try {
      settings.saveApiKey({ pool: POOL, key: "sk-ant-e1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/already exists/);
    expect(statusOf(caught)).toBe(409);
  });

  it("saving with an id that doesn't exist in the pool throws 404", () => {
    process.env[POOL] = "sk-ant-e1";
    let caught: unknown;
    try {
      settings.saveApiKey({ pool: POOL, id: "k_doesnotexist", key: "sk-ant-new" });
    } catch (err) {
      caught = err;
    }
    expect(statusOf(caught)).toBe(404);
  });

  it("deleteApiKey removes the matching key and reports the new pool size", () => {
    process.env[POOL] = "sk-ant-e1,sk-ant-e2,sk-ant-e3";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-e1,sk-ant-e2,sk-ant-e3\n");

    const snap = settings.deleteApiKey({ pool: POOL, id: keyId("sk-ant-e2") });

    expect(process.env[POOL]).toBe("sk-ant-e1,sk-ant-e3");
    const poolSnap = snap.pools.find((p) => p.pool === POOL);
    expect(poolSnap?.total).toBe(2);
  });

  it("deleteApiKey with an unknown id throws 404", () => {
    process.env[POOL] = "sk-ant-e1";
    let caught: unknown;
    try {
      settings.deleteApiKey({ pool: POOL, id: "k_doesnotexist" });
    } catch (err) {
      caught = err;
    }
    expect(statusOf(caught)).toBe(404);
  });

  it("deleteApiKey with an empty id throws 400", () => {
    process.env[POOL] = "sk-ant-e1";
    let caught: unknown;
    try {
      settings.deleteApiKey({ pool: POOL, id: "" });
    } catch (err) {
      caught = err;
    }
    expect(statusOf(caught)).toBe(400);
  });
});

describe("importKeys", () => {
  // Only unambiguous-prefix keys (sk-ant-...) are used here: classifyKeyPrefix() resolves those
  // from the prefix alone with zero network I/O. A key with an unrecognized-but-key-shaped format
  // (16+ alphanumeric chars) or a bare "sk-" would instead fall into resolveKeyBrand's live-probe
  // path (src/keyDetect.ts -> src/modelCatalog.ts probeKey), which is a REAL network call with no
  // MOCK gate. So the "unknown"/"no_service" result statuses are intentionally not exercised here.
  it("adds a brand-new key and flags an already-present one as a duplicate, with no network I/O", async () => {
    process.env[POOL] = "sk-ant-existing1";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-existing1\n");

    const result = await settings.importKeys({ text: "sk-ant-existing1\nsk-ant-brandnew2\n" });

    expect(result.added).toBe(1);
    const byKey = new Map(result.results.map((r) => [r.mask, r.status]));
    expect([...byKey.values()].sort()).toEqual(["added", "duplicate"]);
    expect(process.env[POOL]).toBe("sk-ant-existing1,sk-ant-brandnew2");
    expect(readEnvFile()).toBe("ANTHROPIC_API_KEYS=sk-ant-existing1,sk-ant-brandnew2\n");
  });

  it("re-importing the same blob a second time adds nothing", async () => {
    // parseKeyBlob (src/keyDetect.ts) only treats tokens of 16+ chars as key-shaped, so these
    // need to be at least that long to survive parsing (unlike the direct saveApiKey/deleteApiKey
    // tests above, which never go through parseKeyBlob and can use shorter fake keys).
    process.env[POOL] = "sk-ant-onlykey01";
    writeEnvFile("ANTHROPIC_API_KEYS=sk-ant-onlykey01\n");

    const first = await settings.importKeys({ text: "sk-ant-onlykey01\nsk-ant-onlykey02\n" });
    expect(first.added).toBe(1);
    const second = await settings.importKeys({ text: "sk-ant-onlykey01\nsk-ant-onlykey02\n" });
    expect(second.added).toBe(0);
    expect(second.results.every((r) => r.status === "duplicate")).toBe(true);
  });
});

describe("validation: normalizeApiKey / assertKeyPool", () => {
  beforeEach(() => {
    process.env[POOL] = "sk-ant-e1";
  });

  it("rejects a key containing a comma", () => {
    expect(() => settings.saveApiKey({ pool: POOL, key: "sk-ant-a,sk-ant-b" })).toThrow(/comma/);
  });

  it("rejects a key containing a newline", () => {
    expect(() => settings.saveApiKey({ pool: POOL, key: "sk-ant-a\nsk-ant-b" })).toThrow(/comma|line/);
  });

  it("rejects an empty key", () => {
    expect(() => settings.saveApiKey({ pool: POOL, key: "" })).toThrow(/required/);
  });

  it("rejects an unknown key pool", () => {
    let caught: unknown;
    try {
      settings.saveApiKey({ pool: "NOT_A_REAL_POOL_XYZ", key: "sk-ant-a" });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/unknown key pool/);
    expect(statusOf(caught)).toBe(400);
  });
});

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/http/app";
import type { Manifest } from "../src/store";
import * as store from "../src/store";

describe("store: stale run manifests", () => {
  const staleNow = new Date("2026-07-01T12:00:00Z");
  const staleRunId = `20990101-000000-stale-${process.pid}`;
  const activeRunId = `20990101-000001-active-${process.pid}`;
  const runningManifest = (runId: string) => ({
    runId,
    createdAt: "2026-06-01T00:00:00Z",
    finishedAt: null,
    status: "running",
    counts: { total: 2, done: 1, ok: 1, error: 0, skipped: 0 },
    inputs: [],
    prompts: [],
    models: [],
    jobs: [
      { id: "complete", status: "ok", finishedAt: "2026-06-01T00:01:00Z" },
      { id: "unfinished", status: "running", startedAt: "2026-06-01T00:02:00Z", finishedAt: null },
    ],
  });

  afterAll(() => {
    try { fs.rmSync(store.runDir(staleRunId), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(store.runDir(activeRunId), { recursive: true, force: true }); } catch (_) {}
  });

  it("settles a stale running manifest into a terminal error and recounts unfinished jobs", () => {
    store.writeManifest(staleRunId, runningManifest(staleRunId) as Manifest);
    const settled = store.readManifest(staleRunId, { staleAfterMs: 0, now: staleNow, reason: "test stale run", reconcile: true })!;
    expect(settled.status).toBe("error");
    expect(settled.counts).toEqual({ total: 2, done: 2, ok: 1, error: 1, skipped: 0 });
    const unfinished = settled.jobs!.find((j) => j.id === "unfinished")!;
    expect(unfinished.status).toBe("error");
    expect(/test stale run/.test(unfinished.error || "")).toBe(true);
    expect(store.readManifest(staleRunId, { activeRunIds: [staleRunId] })!.status).toBe("error");
  });

  it("does not settle an active in-memory run as stale", () => {
    store.writeManifest(activeRunId, runningManifest(activeRunId) as Manifest);
    const active = store.readManifest(activeRunId, {
      staleAfterMs: 0,
      now: staleNow,
      activeRunIds: [activeRunId],
    })!;
    expect(active.status).toBe("running");
  });

  it("does not mutate an unowned legacy manifest during an ordinary read", () => {
    const legacyRunId = `20990101-000002-legacy-${process.pid}`;
    try {
      store.writeManifest(legacyRunId, runningManifest(legacyRunId) as Manifest);
      expect(store.readManifest(legacyRunId, { staleAfterMs: 0, now: staleNow })!.status).toBe("running");
    } finally {
      fs.rmSync(store.runDir(legacyRunId), { recursive: true, force: true });
    }
  });

  it("leaves a recoverable held queued manifest alone during reconciliation", () => {
    const heldRunId = `20990101-000002-held-${process.pid}`;
    try {
      store.writeManifest(heldRunId, {
        ...runningManifest(heldRunId),
        status: "queued",
        queue: { held: true },
      } as Manifest);
      expect(store.readManifest(heldRunId, { staleAfterMs: 0, now: staleNow, reconcile: true })!.status).toBe("queued");
    } finally {
      fs.rmSync(store.runDir(heldRunId), { recursive: true, force: true });
    }
  });
});

describe("store: per-run ownership", () => {
  const runId = `20990101-000003-owner-${process.pid}`;

  afterAll(() => {
    fs.rmSync(store.runDir(runId), { recursive: true, force: true });
  });

  it("keeps a live owned run from being settled even with a zero stale window", () => {
    store.writeManifest(runId, {
      runId,
      createdAt: "2026-06-01T00:00:00Z",
      finishedAt: null,
      status: "running",
      jobs: [],
    } as Manifest);
    const claim = store.claimRunOwnership(runId);
    try {
      expect(store.isRunOwned(runId)).toBe(true);
      expect(store.readManifest(runId, { staleAfterMs: 0, reconcile: true })!.status).toBe("running");
    } finally {
      claim.release();
    }
  });

  it("reclaims a dead owner and reports a live collision as 409", () => {
    const ownerFile = path.join(store.runDir(runId), ".owner.json");
    fs.mkdirSync(store.runDir(runId), { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: 2147483647, token: "dead-owner", createdAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T00:00:00.000Z" }));
    expect(store.isRunOwned(runId)).toBe(false);

    const first = store.claimRunOwnership(runId);
    try {
      store.claimRunOwnership(runId);
      throw new Error("expected ownership collision");
    } catch (error: unknown) {
      expect((error as { status?: number }).status).toBe(409);
    }
    first.release();
    expect(store.isRunOwned(runId)).toBe(false);
  });

  it("does not let a released predecessor remove a successor's token", () => {
    const first = store.claimRunOwnership(runId);
    const ownerFile = path.join(store.runDir(runId), ".owner.json");
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: process.pid,
      token: "successor-token",
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));
    first.release();
    expect(store.isRunOwned(runId)).toBe(true);
    fs.unlinkSync(ownerFile);
  });

  it("treats a live PID as owned even when its heartbeat is late", () => {
    const ownerFile = path.join(store.runDir(runId), ".owner.json");
    fs.mkdirSync(store.runDir(runId), { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: process.pid,
      token: "busy-process-token",
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(store.isRunOwned(runId)).toBe(true);
    fs.unlinkSync(ownerFile);
  });
});

describe("store: run id path-traversal guard", () => {
  const traversalIds = ["../package.json", "..\\package.json", "..", ".", "a/../../package.json"];

  it("readManifest rejects traversal ids instead of resolving outside OUTPUT_DIR", () => {
    for (const id of traversalIds) {
      expect(() => store.readManifest(id)).toThrow();
    }
  });

  it("writeManifest rejects traversal ids instead of resolving outside OUTPUT_DIR", () => {
    for (const id of traversalIds) {
      expect(() => store.writeManifest(id, { runId: id, status: "ok" } as Manifest)).toThrow();
    }
  });

  it("deleteRun rejects traversal ids instead of resolving outside OUTPUT_DIR", () => {
    for (const id of traversalIds) {
      expect(() => store.deleteRun(id)).toThrow();
    }
  });
});

describe("http: GET /api/runs/:id rejects an encoded traversal id", () => {
  let server: ReturnType<typeof Bun.serve>;

  afterAll(() => {
    server.stop(true);
  });

  it("never returns 200 or a manifest for an encoded ../ id", async () => {
    const app = createApp();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;

    // %2f decodes to "/", so these are the encoded forms of "../../package.json" and
    // "/../../package.json" once Hono decodes the :id route param — the exact shape the
    // audit's live repro used.
    for (const encodedId of ["..%2f..%2fpackage.json", "%2f..%2f..%2fpackage.json"]) {
      const res = await fetch(`${base}/api/runs/${encodedId}`);
      expect(res.status).not.toBe(200);
      expect([400, 404]).toContain(res.status);
      const body = await res.json();
      expect(body.name).toBeUndefined();
      expect(body.version).toBeUndefined();
    }
  });
});

import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import { createApp } from "../src/http/app";
import * as store from "../src/store";
import type { Manifest } from "../src/store";

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
    const settled = store.readManifest(staleRunId, { staleAfterMs: 0, now: staleNow, reason: "test stale run" })!;
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

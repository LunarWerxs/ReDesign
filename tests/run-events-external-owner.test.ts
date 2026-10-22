import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "../src/http/app";
import * as store from "../src/store";

const runId = `20990101-000004-external-events-${process.pid}`;

afterEach(() => {
  try {
    store.deleteRun(runId);
  } catch {
    /* The assertion may have failed before the manifest was created. */
  }
});

describe("GET /api/runs/:id/events for externally owned work", () => {
  it("replays a live snapshot instead of settling or reporting the run done", async () => {
    store.writeManifest(runId, {
      runId,
      // A week old: past the 24h default staleness window, so this is exactly the kind of manifest
      // the owner lease has to protect. Computed off the clock rather than pinned to a literal so
      // it stays past that window instead of aging relative to it.
      createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      finishedAt: null,
      status: "running",
      jobs: [],
    });
    const claim = store.claimRunOwnership(runId);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp().fetch });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runs/${runId}/events`);
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      expect(first).toContain('"type":"snapshot"');
      expect(first).toContain('"status":"running"');
    } finally {
      claim.release();
      server.stop(true);
    }
  });
});

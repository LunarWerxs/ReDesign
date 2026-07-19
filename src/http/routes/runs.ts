/**
 * GET /api/runs, POST /api/runs/delete, GET /api/runs/:id, GET /api/runs/:id/events (SSE),
 * POST /api/run, POST /api/runs/:id/cancel. Ported from server.js; the SSE subscription
 * (sseSubscribe) now uses Hono's streamSSE fed from http/runQueue.ts's broadcast().
 *
 * SSE contract preserved exactly: `retry: 3000` first, replay the last manifest as `snapshot` if
 * the run is still live, a final `done` if it already finished, and a 25s `: ping` heartbeat
 * (the heartbeat itself lives in runQueue.ts so it fires even between/without an active
 * subscriber lookup here).
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import * as store from "../../store";
import { activeRuns, runStoreOptions, ORPHANED_RUN_MESSAGE, enqueueRun, releaseQueue, heldRunCount, cancelRun, normalizeRunDeleteIds, deleteRuns, type SseClient } from "../runQueue";

export function register(app: Hono, _deps: Deps): void {
  // Static segments ("delete") are registered before the "/:id" param routes below, Hono's
  // router resolves a literal segment over a param match regardless of registration order, but
  // keeping this order mirrors server.js's original if/else-if dispatch for readability.
  app.get("/api/runs", (c) => c.json(store.listRuns(runStoreOptions())));

  app.post("/api/runs/delete", requireSameOrigin(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ids = normalizeRunDeleteIds(body);
    if (!ids.length) return c.json({ error: "ids are required" }, 400);
    return c.json(deleteRuns(ids));
  });

  app.get("/api/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const client: SseClient = { write: (payload) => void stream.write(payload) };
      const entry = activeRuns.get(runId);
      await stream.write("retry: 3000\n\n");
      if (!entry) {
        // Run already finished, replay the manifest from disk, then close. An invalid/
        // traversal id makes readManifest throw (store.resolveRunDir), so treat it as
        // "no manifest" rather than leaking an error or a file outside OUTPUT_DIR.
        let m: store.Manifest | null = null;
        try {
          m = store.readManifest(runId, runStoreOptions({ staleAfterMs: 0, reason: ORPHANED_RUN_MESSAGE }));
        } catch (_) {
          m = null;
        }
        await stream.write(`data: ${JSON.stringify({ type: "done", runId, manifest: m })}\n\n`);
        return;
      }
      entry.clients.add(client);
      if (entry.lastManifest) {
        await stream.write(`data: ${JSON.stringify({ type: "snapshot", runId, manifest: entry.lastManifest })}\n\n`);
      }
      stream.onAbort(() => {
        entry.clients.delete(client);
      });
      // Keep the handler alive until the client disconnects; broadcast()/heartbeat (runQueue.ts)
      // write to `stream` from the outside via `client.write` for the lifetime of this run.
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });

  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    let m: store.Manifest | null;
    try {
      m = store.readManifest(id, runStoreOptions());
    } catch (err) {
      // Invalid/traversal id rejected by store.resolveRunDir — return its status (400).
      const status = (err as { status?: number })?.status ?? 400;
      return c.json({ error: "invalid run id" }, status as 400 | 404);
    }
    return m ? c.json(m) : c.json({ error: "run not found" }, 404);
  });

  app.post("/api/run", requireSameOrigin(), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const runId = enqueueRun(body);
    return c.json({ runId });
  });

  // Start everything the control panel has parked with `autoStart: false`. Idempotent:
  // pressing it with nothing held simply reports 0 and leaves the running queue alone.
  app.post("/api/queue/start", requireSameOrigin(), (c) => {
    const started = releaseQueue();
    return c.json({ started, held: heldRunCount() });
  });

  app.post("/api/runs/:id/cancel", requireSameOrigin(), (c) => {
    const runId = c.req.param("id");
    return c.json({ ok: cancelRun(runId) });
  });
}

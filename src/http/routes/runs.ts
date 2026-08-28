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
import fs from "node:fs";
import type { Env, Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import * as store from "../../store";
import { resolveInside } from "../../util";
import { buildZip, type ZipEntry } from "../../zip";
import { ensureRunThumbnail } from "../../thumbnail";
import { loadModels } from "../../config";
import { activeRuns, runStoreOptions, ORPHANED_RUN_MESSAGE, enqueueRun, releaseQueue, reorderQueue, heldRunCount, cancelRun, normalizeRunDeleteIds, deleteRuns, type SseClient } from "../runQueue";

/** The fields runReimagine writes onto every job that the retry route needs to rebuild a run. */
interface RetryJob {
  id: string;
  status: string;
  inputId: string;
  promptId: string;
  modelId: string;
}

/** A prompt as recorded on the manifest, enough to tell a preset from a custom one. */
interface ManifestPrompt {
  id: string;
  source?: string;
  user?: string;
}

// GET /api/runs/:id/events (SSE). Pulled out of register() so its branching scores against
// this small function instead of register's — see connections.ts's putSettingsSync for the
// same pattern already used in this codebase.
function handleRunEvents(c: Context<Env, "/api/runs/:id/events">) {
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
}

// GET /api/runs/:id/thumbnail, with on-demand backfill for older runs that never saved one
// (see src/thumbnail.ts): existing thumb → surviving input screenshot → a rendered output
// preview → 404 (the gallery then shows its placeholder). Pulled out of register(), see
// handleRunEvents above.
async function handleRunThumbnail(c: Context<Env, "/api/runs/:id/thumbnail">) {
  let result: Awaited<ReturnType<typeof ensureRunThumbnail>>;
  try {
    result = await ensureRunThumbnail(c.req.param("id"));
  } catch {
    result = null;
  }
  if (!result) return c.json({ error: "no thumbnail" }, 404);
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(result.abs);
  } catch {
    return c.json({ error: "no thumbnail" }, 404);
  }
  return c.body(new Uint8Array(buf), 200, {
    "content-type": result.mime,
    // A run id is unique and never reused, and its thumbnail is stable once made, so let the
    // browser keep it — the render only ever needs to happen once.
    "cache-control": "public, max-age=31536000, immutable",
  });
}

// GET /api/runs/:id/download — every successful output of a run as one .zip. Without it a
// run's redesigns can only be taken off the machine one file at a time, which is the whole
// reason a bake-off is awkward to share. Pulled out of register(), see handleRunEvents above.
async function handleRunDownload(c: Context<Env, "/api/runs/:id/download">) {
  const id = c.req.param("id");
  let m: store.Manifest | null;
  try {
    m = store.readManifest(id, runStoreOptions());
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 400;
    return c.json({ error: "invalid run id" }, status as 400 | 404);
  }
  if (!m) return c.json({ error: "run not found" }, 404);

  const jobs = (m.jobs || []).filter((j) => j.status === "ok" && j.file);
  if (!jobs.length) return c.json({ error: "this run has no successful outputs" }, 404);

  const entries: ZipEntry[] = [];
  for (const job of jobs) {
    // job.file is "<runId>/<inputId>/<name>.html"; resolveInside re-checks it against OUTPUT_DIR
    // rather than trusting a path read back off disk.
    let abs: string;
    try {
      abs = resolveInside(store.OUTPUT_DIR, job.file as string, { decode: false }).full;
    } catch (_) {
      continue;
    }
    let data: Buffer;
    let modified: Date | undefined;
    try {
      data = await fs.promises.readFile(abs);
      modified = (await fs.promises.stat(abs)).mtime;
    } catch (_) {
      continue; // an output deleted from under us shouldn't fail the whole download
    }
    // Flatten one level below the run so the zip opens as <runId>/<input>/<file>.html.
    entries.push({ name: String(job.file).split("/").slice(1).join("/") || `${job.id}.html`, data: new Uint8Array(data), modified });
  }
  if (!entries.length) return c.json({ error: "no output files are still on disk for this run" }, 404);

  let zip: Uint8Array<ArrayBuffer>;
  try {
    zip = await buildZip(entries);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "could not build the archive" }, 500);
  }
  const safeId = String(m.runId || id).replace(/[^\w.-]+/g, "_") || "run";
  return c.body(zip, 200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${safeId}.zip"`,
    "cache-control": "no-store",
  });
}

// inputId -> promptId -> modelId -> how many jobs of that exact combination need redoing.
// Nested maps rather than a joined string key so no id value can collide with a separator.
function groupRetryTargets(targets: RetryJob[]): Map<string, Map<string, Map<string, number>>> {
  const groups = new Map<string, Map<string, Map<string, number>>>();
  for (const job of targets) {
    const byPrompt = groups.get(job.inputId) ?? new Map<string, Map<string, number>>();
    const byModel = byPrompt.get(job.promptId) ?? new Map<string, number>();
    byModel.set(job.modelId, (byModel.get(job.modelId) ?? 0) + 1);
    byPrompt.set(job.promptId, byModel);
    groups.set(job.inputId, byPrompt);
  }
  return groups;
}

// Submits one run per (input, prompt) group with per-model quantities, so the retry reproduces
// EXACTLY the failed set. Sending one run with the union of inputs/models/prompts would be
// simpler and would silently re-run combinations that already succeeded, which on this app
// means spending real money the user did not ask to spend.
function submitRetryRuns(
  groups: Map<string, Map<string, Map<string, number>>>,
  promptById: Map<string, ManifestPrompt>,
  m: store.Manifest,
  id: string,
  config: Record<string, unknown>,
  reference: { images?: unknown; note?: string | null } | null | undefined,
  autoStart: boolean,
): string[] {
  const runIds: string[] = [];
  for (const [inputId, byPrompt] of groups) {
    for (const [promptId, models] of byPrompt) {
      const prompt = promptById.get(promptId);
      // A custom prompt is not addressable by id (resolvePrompts rebuilds it from its text), so
      // pass the recorded text back through rather than losing it on retry.
      const isCustom = prompt?.source === "custom";
      runIds.push(
        enqueueRun({
          label: `Retry · ${m.runId || id}`,
          mock: m.mock === true,
          inputs: [inputId],
          models: [...models.keys()],
          prompts: isCustom ? { custom: String(prompt?.user || "") } : { presets: [promptId] },
          modelQuantities: Object.fromEntries(models),
          concurrency: config.concurrency as number | undefined,
          poolConcurrency: config.poolConcurrency as number | undefined,
          maxImages: config.maxImagesPerInput as number | undefined,
          reference: reference?.images ? { images: reference.images, note: reference.note || undefined } : null,
          brandStyleGuide: typeof config.brandStyleGuide === "string" ? config.brandStyleGuide : null,
          autoStart,
        }),
      );
    }
  }
  return runIds;
}

// POST /api/runs/:id/retry — re-run only the jobs that failed or were skipped, instead of
// paying for the whole fan-out again because one key was dead. Body: { jobIds?: string[],
// autoStart?: boolean }; with no jobIds every non-ok job is retried. Pulled out of register(),
// see handleRunEvents above.
async function handleRunRetry(c: Context<Env, "/api/runs/:id/retry">) {
  const id = c.req.param("id");
  let m: store.Manifest | null;
  try {
    m = store.readManifest(id, runStoreOptions());
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 400;
    return c.json({ error: "invalid run id" }, status as 400 | 404);
  }
  if (!m) return c.json({ error: "run not found" }, 404);
  if (activeRuns.get(id) && !activeRuns.get(id)?.finished) {
    return c.json({ error: "this run is still going; wait for it to finish or cancel it first" }, 409);
  }

  const body = ((await c.req.json().catch(() => ({}))) || {}) as { jobIds?: unknown; autoStart?: unknown };
  const wanted = Array.isArray(body.jobIds) ? new Set(body.jobIds.map((x) => String(x))) : null;
  // store.Job is deliberately loose (a status plus an index signature) because store.ts doesn't
  // own the job shape; narrow it here to the fields the runner actually writes and this route
  // needs to rebuild a submission.
  const retryable = ((m.jobs || []) as unknown as RetryJob[]).filter(
    (j) => j.status === "error" || j.status === "skipped" || j.status === "cancelled",
  );
  const targets = wanted ? retryable.filter((j) => wanted.has(String(j.id))) : retryable;
  if (!targets.length) return c.json({ error: "nothing to retry in this run" }, 400);

  const config = (m.config || {}) as Record<string, unknown>;
  const manifestPrompts = (Array.isArray(m.prompts) ? m.prompts : []) as ManifestPrompt[];
  const promptById = new Map(manifestPrompts.map((p) => [p.id, p]));
  const reference = config.reference as { images?: unknown; note?: string | null } | null | undefined;

  // A model that has since been deleted or disabled is silently dropped by resolveModels rather
  // than raising, so a retry could report "3 jobs" and quietly submit 2. Work out up front which
  // models are still runnable, count only those, and hand the caller the dropped ids so the UI
  // can say what will not come back.
  const liveModelIds = new Set(loadModels().filter((mo) => mo.enabled !== false).map((mo) => mo.id));
  const droppedModels = [...new Set(targets.map((j) => j.modelId).filter((mid) => !liveModelIds.has(mid)))];
  const runnable = targets.filter((j) => liveModelIds.has(j.modelId));
  if (!runnable.length) {
    return c.json({ error: `none of these jobs' models are still available: ${droppedModels.join(", ")}`, droppedModels }, 400);
  }

  const groups = groupRetryTargets(runnable);
  const runIds = submitRetryRuns(groups, promptById, m, id, config, reference, body.autoStart !== false);
  return c.json({ runIds, jobCount: runnable.length, ...(droppedModels.length ? { droppedModels } : {}) });
}

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

  app.get("/api/runs/:id/events", handleRunEvents);

  // Registered before "/:id" so the literal "thumbnail" segment can't be swallowed by the param route.
  app.get("/api/runs/:id/thumbnail", handleRunThumbnail);

  app.get("/api/runs/:id/download", requireSameOrigin(), handleRunDownload);

  app.post("/api/runs/:id/retry", requireSameOrigin(), handleRunRetry);

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

  // Drag-to-reorder the waiting queue. `order` is the desired runId order; only currently-queued
  // runs move (the running one isn't reorderable), and omitted ones keep their place. See
  // runQueue.reorderQueue. Returns the resulting order.
  app.post("/api/queue/reorder", requireSameOrigin(), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    return c.json(reorderQueue((body as { order?: unknown }).order));
  });

  app.post("/api/runs/:id/cancel", requireSameOrigin(), (c) => {
    const runId = c.req.param("id");
    return c.json({ ok: cancelRun(runId) });
  });
}

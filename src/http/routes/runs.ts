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
import type { Context, Env, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadModels } from "../../config";
import * as store from "../../store";
import { ensureRunThumbnail } from "../../thumbnail";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { validateRunRequest } from "../run-request";
import { prepareRun, prepareReplay } from "../run-preflight";
import { readRunSpec } from "../../runner/run-spec";
import { activeRuns, cancelRun, deleteRuns, enqueueRun, heldRunCount, normalizeRunDeleteIds, releaseQueue, reorderQueue, runStoreOptions, type SseClient } from "../runQueue";

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

async function readActionBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value as Record<string, unknown>;
  } catch (_) {
    throw Object.assign(new Error("request body must be a valid JSON object"), { status: 400 });
  }
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
      // A CLI or another daemon owns work this server did not start. Read its manifest without
      // reconciliation: an SSE observer must never turn another process's live batch into an
      // error merely because this process has no in-memory entry for it.
      let m: store.Manifest | null = null;
      try {
        m = store.readManifest(runId, runStoreOptions());
      } catch (_) {
        m = null;
      }
      if (!m || (m.status !== "queued" && m.status !== "running")) {
        await stream.write(`data: ${JSON.stringify({ type: "done", runId, manifest: m })}\n\n`);
        return;
      }
      await stream.write(`data: ${JSON.stringify({ type: "snapshot", runId, manifest: m })}\n\n`);

      // Poll disk for an externally-owned active run. The owner lease is intentionally not used
      // as an expiry signal here: a busy CLI can miss heartbeats, and this observer has no right
      // to settle or otherwise mutate its manifest. We stop only once the external writer records
      // a terminal state or the browser closes the connection.
      await new Promise<void>((resolve) => {
        let stopped = false;
        let polling = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearInterval(timer);
          timer = null;
          resolve();
        };
        const poll = async () => {
          if (stopped || polling) return;
          polling = true;
          try {
            let latest: store.Manifest | null = null;
            try {
              latest = store.readManifest(runId, runStoreOptions());
            } catch (_) {
              latest = null;
            }
            if (!latest || (latest.status !== "queued" && latest.status !== "running")) {
              await stream.write(`data: ${JSON.stringify({ type: "done", runId, manifest: latest })}\n\n`);
              stop();
              return;
            }
            await stream.write(`data: ${JSON.stringify({ type: "snapshot", runId, manifest: latest })}\n\n`);
          } finally {
            polling = false;
          }
        };
        timer = setInterval(() => void poll(), 750);
        timer.unref?.();
        stream.onAbort(stop);
      });
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
async function submitRetryRuns(
  groups: Map<string, Map<string, Map<string, number>>>,
  promptById: Map<string, ManifestPrompt>,
  m: store.Manifest,
  id: string,
  config: Record<string, unknown>,
  reference: { images?: unknown; note?: string | null } | null | undefined,
  autoStart: boolean,
): Promise<string[]> {
  const runIds: string[] = [];
  for (const [inputId, byPrompt] of groups) {
    for (const [promptId, models] of byPrompt) {
      const prompt = promptById.get(promptId);
      // Legacy manifests lack a RunSpec, but still retain the prompt text. Preserve it for
      // named presets too; resolving the ID today would silently change a failed recipe.
      const savedText = typeof prompt?.user === "string" ? prompt.user : "";
      if (!savedText.trim()) throw Object.assign(new Error(`The legacy run did not retain prompt ${promptId}; use current settings to create a new run.`), { status: 409 });
      runIds.push(
        await enqueueRun({
          label: `Retry · ${m.runId || id}`,
          mock: m.mock === true,
          inputs: [inputId],
          models: [...models.keys()],
          prompts: { presets: [], custom: savedText },
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
  if (store.isRunOwned(id) || (activeRuns.get(id) && !activeRuns.get(id)?.finished)) {
    return c.json({ error: "this run is still going; wait for it to finish or cancel it first" }, 409);
  }

  const body = await readActionBody(c);
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.jobIds != null && (!Array.isArray(body.jobIds) || body.jobIds.some((value: unknown) => typeof value !== "string")))) {
    return c.json({ error: "retry requires an object with optional string jobIds" }, 400);
  }
  const wanted = Array.isArray(body.jobIds) ? new Set(body.jobIds.map((x) => String(x))) : null;
  // store.Job is deliberately loose (a status plus an index signature) because store.ts doesn't
  // own the job shape; narrow it here to the fields the runner actually writes and this route
  // needs to rebuild a submission.
  const retryable = ((m.jobs || []) as unknown as RetryJob[]).filter(
    (j) => j.status === "error" || j.status === "skipped" || j.status === "cancelled",
  );
  const targets = wanted ? retryable.filter((j) => wanted.has(String(j.id))) : retryable;
  if (!targets.length) return c.json({ error: "nothing to retry in this run" }, 400);

  if (m.specVersion === 1) {
    if (!readRunSpec(store.runDir(id))) return c.json({ error: "Saved run assets or specification are missing or corrupt; restore them before retrying." }, 409);
    const prepared = await prepareReplay(id, targets.map((job) => job.id));
    const runId = await enqueueRun({ preflightId: prepared.preflightId, autoStart: body.autoStart !== false });
    return c.json({ runIds: [runId], jobCount: targets.length });
  }

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
  const runIds = await submitRetryRuns(groups, promptById, m, id, config, reference, body.autoStart !== false);
  return c.json({ runIds, jobCount: runnable.length, ...(droppedModels.length ? { droppedModels } : {}) });
}

export function register(app: Hono, _deps: Deps): void {
  // Static segments ("delete") are registered before the "/:id" param routes below, Hono's
  // router resolves a literal segment over a param match regardless of registration order, but
  // keeping this order mirrors server.js's original if/else-if dispatch for readability.
  app.get("/api/runs", (c) => {
    const rawLimit = Number(c.req.query("limit") || 50);
    return c.json(store.listRunsPage({ cursor: c.req.query("cursor"), limit: rawLimit, options: runStoreOptions() }));
  });

  app.post("/api/runs/delete", requireSameOrigin(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ids = normalizeRunDeleteIds(body);
    if (!ids.length) return c.json({ error: "ids are required" }, 400);
    return c.json(deleteRuns(ids));
  });

  app.get("/api/runs/:id/events", handleRunEvents);

  // Registered before "/:id" so the literal "thumbnail" segment can't be swallowed by the param route.
  app.get("/api/runs/:id/thumbnail", handleRunThumbnail);


  app.post("/api/runs/:id/retry", requireSameOrigin(), handleRunRetry);

  app.post("/api/runs/:id/repeat", requireSameOrigin(), async (c) => {
    const id = c.req.param("id");
    if (store.isRunOwned(id)) return c.json({ error: "This run is still active." }, 409);
    if (!store.readManifest(id)) return c.json({ error: "run not found" }, 404);
    const body = await readActionBody(c);
    if (!body || typeof body !== "object" || Array.isArray(body) || (body.autoStart != null && typeof body.autoStart !== "boolean")) return c.json({ error: "invalid repeat request" }, 400);
    const prepared = await prepareReplay(id);
    return c.json({ runId: await enqueueRun({ preflightId: prepared.preflightId, autoStart: body.autoStart !== false }) });
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
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (_) {
      return c.json({ error: "invalid JSON request body" }, 400);
    }
    const body = validateRunRequest(rawBody);
    const runId = await enqueueRun(body);
    return c.json({ runId });
  });

  app.post("/api/run/preflight", requireSameOrigin(), async (c) => {
    let rawBody: unknown;
    try { rawBody = await c.req.json(); } catch (_) { return c.json({ error: "invalid JSON request body" }, 400); }
    const body = validateRunRequest(rawBody);
    if (body.preflightId) return c.json({ error: "Preflight expects a recipe, not an existing token." }, 400);
    return c.json(await prepareRun(body));
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

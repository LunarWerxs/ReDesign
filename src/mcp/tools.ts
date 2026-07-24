// RēDesign MCP tool table, a thin HTTP-client proxy to the RUNNING RēDesign server. Each tool
// is a 1:1 wrapper over an endpoint that already exists in src/http/routes/*.ts (the Hono port of
// the old server.js). The web UI, the CLI, and agents all
// share this one source of truth: start the server first (`redesign serve`); point elsewhere with
// REDESIGN_URL / PORT / HOST.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// ./mcp-stdio.mjs (part of the shared kit, edit it there, never here); ./stdio.ts wires
// this tool table into it via a static import (the CJS version bridged with a dynamic import()).
import type { McpEngineTool } from "../mcp-stdio.mjs";

// ── HTTP client over the running server (mirrors the CLI's serverBase in src/cli/lifecycle.ts) ──
function base(): string {
  if (process.env.REDESIGN_URL) return process.env.REDESIGN_URL;
  const host = process.env.HOST && process.env.HOST !== "0.0.0.0" ? process.env.HOST : "127.0.0.1";
  const port = process.env.PORT || 5178;
  return `http://${host}:${port}`;
}

async function apiCall(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base()}${pathname}`, init);
  } catch (e) {
    throw new Error(
      `couldn't reach the RēDesign server at ${base()}, start it with \`redesign serve\`. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`RēDesign ${res.status}: ${text || res.statusText}`);
  return text ? JSON.parse(text) : {};
}
const get = (p: string): Promise<unknown> => apiCall(p);
const post = (p: string, body?: unknown): Promise<unknown> =>
  apiCall(p, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const str = (v: unknown): string => String(v ?? "");

export const TOOLS: McpEngineTool[] = [
  {
    name: "snapshot",
    description: "Full snapshot of the app: models, prompt presets, inputs, references, API key-pool health, and recent runs.",
    inputSchema: obj(),
    run: () => get("/api/bootstrap"),
  },
  {
    name: "list_inputs",
    description: "List discovered inputs (the screenshots / grouped screenshot sets found in ./input).",
    inputSchema: obj(),
    run: () => get("/api/inputs"),
  },
  {
    name: "key_health",
    description: "API key-pool health per provider (counts + cooldowns only, never the key values).",
    inputSchema: obj(),
    run: () => get("/api/keys"),
  },
  {
    name: "list_runs",
    description: "List recent runs (newest first) with their status and ok/error counts.",
    inputSchema: obj(),
    run: () => get("/api/runs"),
  },
  {
    name: "get_run",
    description: "Get one run's manifest by runId: status, per-job results, and the output directory.",
    inputSchema: obj({ runId: { type: "string", description: "the run id, e.g. from list_runs or the run tool" } }, ["runId"]),
    run: (a) => get(`/api/runs/${encodeURIComponent(str(a.runId))}`),
  },
  {
    name: "run",
    description:
      'Queue a reimagine job: send input screenshot(s) through models × prompts and collect reimagined HTML. Returns { runId } immediately, poll get_run for progress. Set mock:true for a no-API-spend dry run.',
    inputSchema: obj({
      input: { type: "string", description: '"all" or comma-separated input ids (default all)' },
      models: { type: "string", description: '"all" or comma-separated model ids (default all)' },
      prompts: { type: "string", description: '"all" or comma-separated preset ids (default all; ignored if only custom is given)' },
      custom: { type: "string", description: "a custom prompt to run alongside (or instead of) the presets" },
      reference: { type: "string", description: '"all" or comma-separated reference image filenames from reference/ to feed as style guides' },
      reference_note: { type: "string", description: "how the model should use the reference image(s)" },
      variants: { type: "number", description: "outputs per model/prompt (default 1)" },
      mock: { type: "boolean", description: "no real API calls, placeholder HTML (pipeline test)" },
      ground: { type: "boolean", description: "ground vision models with a full written inventory of the screenshot first, so they capture every element and drop less (default false)" },
      concurrency: { type: "number", description: "max parallel calls across the whole run" },
      max_images: { type: "number", description: "cap reference images per input group" },
      label: { type: "string", description: "tag added to the run id" },
    }),
    // Build the /api/run body the same way the CLI's `run` verb builds its options
    // (src/cli/run.ts), so an agent passes simple fields and the structured prompt/reference
    // objects are assembled here.
    run: (a) =>
      post("/api/run", {
        inputs: a.input || "all",
        models: a.models || "all",
        prompts: { presets: a.prompts || (a.custom ? [] : "all"), custom: a.custom || null },
        reference: a.reference ? { images: a.reference, note: a.reference_note || null } : null,
        variants: a.variants || 1,
        mock: !!a.mock,
        groundWithDescription: !!a.ground,
        concurrency: a.concurrency,
        maxImages: a.max_images,
        label: a.label,
      }),
  },
  {
    name: "cancel_run",
    description: "Cancel an in-flight run by runId.",
    inputSchema: obj({ runId: { type: "string" } }, ["runId"]),
    run: (a) => post(`/api/runs/${encodeURIComponent(str(a.runId))}/cancel`),
  },
  {
    name: "batch_reimagine",
    description:
      'Composite recipe: queue a reimagine batch and optionally wait for it. wait:false (default) returns { runId, note } immediately, poll get_run yourself. wait:true polls internally (up to timeout_secs, default 120, capped at 300) and returns a structured digest: { runId, status, jobs: [{ input, model, prompt, variant, status, outputFile, caption, error }], captionSummary }. Set mock:true for a no-API-spend dry run.',
    inputSchema: obj({
      inputs: { type: "string", description: '"all" or comma-separated input ids (default all)' },
      prompts: { type: "string", description: '"all" or comma-separated preset ids (default all; ignored if only custom is given)' },
      custom: { type: "string", description: "a custom prompt to run alongside (or instead of) the presets" },
      models: { type: "string", description: '"all" or comma-separated model ids (default all)' },
      variants: { type: "number", description: "outputs per model/prompt (default 1)" },
      mock: { type: "boolean", description: "no real API calls, placeholder HTML (pipeline test)" },
      ground: { type: "boolean", description: "ground vision models with a full written inventory of the screenshot first, so they capture every element and drop less (default false)" },
      wait: { type: "boolean", description: "poll until the run finishes (or timeout_secs elapses) and return a digest instead of just { runId } (default false)" },
      timeout_secs: { type: "number", description: "max seconds to poll when wait:true (default 120, capped at 300)" },
      label: { type: "string", description: "tag added to the run id" },
    }),
    run: async (a) => {
      const { runId } = (await post("/api/run", {
        inputs: a.inputs || "all",
        models: a.models || "all",
        prompts: { presets: a.prompts || (a.custom ? [] : "all"), custom: a.custom || null },
        variants: a.variants || 1,
        mock: !!a.mock,
        groundWithDescription: !!a.ground,
        label: a.label,
      })) as { runId: string };

      if (!a.wait) return { runId, note: "queued, poll get_run(runId) for progress, or call batch_reimagine again with wait:true" };

      const timeoutMs = Math.min(Math.max(1, Number(a.timeout_secs) || 120), 300) * 1000;
      const deadline = Date.now() + timeoutMs;
      const RUNNING_STATUSES = new Set(["queued", "running"]);
      let manifest: Record<string, unknown> = {};
      for (;;) {
        manifest = (await get(`/api/runs/${encodeURIComponent(runId)}`)) as Record<string, unknown>;
        if (!RUNNING_STATUSES.has(str(manifest.status)) || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return buildDigest(runId, manifest);
    },
  },
];

interface DigestJob {
  input: string;
  model: string;
  prompt: string;
  variant: number;
  status: string;
  outputFile: string | null;
  caption: string | null;
  error: string | null;
}

// Read a job's caption out of its .meta.json sidecar (written next to the output HTML by the
// runner, see src/runner/reimagine.ts). Best-effort: absent/unreachable → null, never throws.
async function captionFor(file: string | null | undefined): Promise<string | null> {
  if (!file) return null;
  try {
    const metaPath = `/output-raw/${file.replace(/\.html$/, ".meta.json")}`;
    const meta = (await get(metaPath)) as { caption?: string | null };
    return meta?.caption ?? null;
  } catch (_) {
    return null;
  }
}

async function buildDigest(runId: string, manifest: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rawJobs = Array.isArray(manifest.jobs) ? (manifest.jobs as Record<string, unknown>[]) : [];
  const jobs: DigestJob[] = await Promise.all(
    rawJobs.map(async (j) => ({
      input: str(j.inputId),
      model: str(j.modelId),
      prompt: str(j.promptId),
      variant: Number(j.variant) || 1,
      status: str(j.status),
      outputFile: (j.file as string) || null,
      caption: await captionFor(j.file as string | null | undefined),
      error: (j.error as string) || null,
    })),
  );
  const captioned = jobs.filter((j) => j.caption);
  const captionSummary = captioned.length
    ? `${captioned.length}/${jobs.length} job(s) carry a text-only-model caption (see each job's .caption).`
    : "no text-only-model captions on this run (all models were vision-capable, or the run hasn't finished captioning yet).";
  return {
    runId,
    status: str(manifest.status) || "unknown",
    jobs,
    captionSummary,
  };
}

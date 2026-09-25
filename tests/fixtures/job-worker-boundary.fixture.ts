import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Model } from "../../src/config/models";
import type { ResolvedPrompt } from "../../src/config/prompts";
import type { InputItem } from "../../src/inputResolver";
import type { JobWorkerContext } from "../../src/runner/job-worker";
import type { Job } from "../../src/runner/scheduling";
import type * as Store from "../../src/store";

type Mode = "missing-caption" | "prose" | "fragment" | "cancelled-caption" | "slop-retry";

const mode = process.argv[2] as Mode;
if (!new Set<Mode>(["missing-caption", "prose", "fragment", "cancelled-caption", "slop-retry"]).has(mode)) throw new Error("invalid fixture mode");

// Capture util before loading any module that reads ROOT, then replace just its location
// exports. The child process is the boundary: no real output/config/key-state is touched.
const realUtil = await import("../../src/util");
const tempRoot = String(process.env.REDESIGN_TEST_ROOT || "");
const tempHome = String(process.env.REDESIGN_TEST_HOME || "");
if (!tempRoot || !tempHome) throw new Error("missing isolated fixture paths");
mock.module("../../src/util", () => ({ ...realUtil, ROOT: tempRoot, APP_CONFIG_DIR: tempHome, ENV_FILE: path.join(tempHome, ".env") }));

const [{ KeyManager }, { runOneJob }, { buildJobs }, store] = await Promise.all([
  import("../../src/keyManager"),
  import("../../src/runner/job-worker"),
  import("../../src/runner/scheduling"),
  import("../../src/store"),
]);

let calls = 0;
const requestBodies: string[] = [];
// slop-retry: the first answer trips two P0 anti-slop rules (purple gradient, emoji icons) and the
// re-prompted second answer is clean, so the worker should keep the retry.
const SLOP_HTML =
  '<!DOCTYPE html><html><head><style>.hero{background:linear-gradient(135deg,#7c3aed,#db2777)}</style></head><body><section class="hero"><h1>Dashboard</h1><div>\u{1F680}</div><div>✨</div></section></body></html>';
const CLEAN_HTML = '<!DOCTYPE html><html><head><style>.hero{background:#f4f1ea;color:#1c1b19}</style></head><body><section class="hero"><h1>Dashboard</h1></section></body></html>';
const responseFor = (call: number) =>
  mode === "prose" ? "I cannot produce the requested redesign." : mode === "slop-retry" ? (call === 1 ? SLOP_HTML : CLEAN_HTML) : "<section><h1>Valid fragment</h1></section>";
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  calls++;
  requestBodies.push(typeof init?.body === "string" ? init.body : "");
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: responseFor(calls) }, finish_reason: mode === "prose" ? "length" : "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

const model: Model = {
  id: "text-only-test",
  label: "Text only test",
  provider: "openai",
  apiModel: "test-model",
  keyEnv: "__TEST_TEXT_ONLY_KEYS__",
  baseUrl: "http://provider.test/v1",
  vision: false,
  maxTokens: 100,
};
const prompt: ResolvedPrompt = { id: "test-prompt", label: "Test prompt", user: "Produce a redesign.", source: "preset" };
const input: InputItem = { id: "test-input", name: "test.png", type: "image", imageCount: 1, images: ["test.png"], preview: "test.png" };
const runId = "job-worker-boundary";
const job = buildJobs({ inputItems: [input], models: [model], prompts: [prompt], variants: 1 })[0] as Job;
const manifest = {
  runId,
  status: "running",
  counts: { total: 1, done: 0, ok: 0, error: 0, skipped: 0 },
  cost: { totalCost: 0, currency: "USD", jobCount: 0, anyEstimatePricing: false, anyUnpriced: false },
} as Store.Manifest;
const abortController = new AbortController();
const describeInput: JobWorkerContext["describeInput"] = async () => {
  if (mode === "cancelled-caption") abortController.abort();
  return mode === "missing-caption" || mode === "cancelled-caption" ? null : "a detailed screenshot caption";
};
const ctx: JobWorkerContext = {
  runId,
  manifest,
  mock: false,
  signal: mode === "cancelled-caption" ? abortController.signal : null,
  timeoutMs: 100,
  systemContract: "",
  brandStyleGuide: "",
  km: new KeyManager({ stateFile: String(process.env.REDESIGN_TEST_KEY_STATE) }),
  modelById: new Map([[model.id, model]]),
  promptById: new Map([[prompt.id, prompt]]),
  inputById: new Map([[input.id, input]]),
  imagesFor: () => [],
  describeInput,
  describeReference: async () => null,
  describer: null,
  referenceImages: [],
  referenceRels: [],
  referenceNote: "",
  onProgress: () => {},
  markManifestDirty: () => {},
};

await runOneJob(job, ctx);

const output = job.file ? fs.readFileSync(path.join(store.OUTPUT_DIR, job.file), "utf8") : null;
const meta = job.file ? JSON.parse(fs.readFileSync(path.join(store.OUTPUT_DIR, job.file.replace(/\.html$/, ".meta.json")), "utf8")) : null;
const retryPromptHasFindings = (requestBodies[1] || "").includes("purple-gradient");
process.stdout.write(`${JSON.stringify({ calls, job, counts: manifest.counts, output, meta, retryPromptHasFindings })}\n`);

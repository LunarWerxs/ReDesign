import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Model } from "../../src/config/models";
import type { ResolvedPrompt } from "../../src/config/prompts";
import type { InputItem } from "../../src/inputResolver";
import type { JobWorkerContext } from "../../src/runner/job-worker";
import type { Job } from "../../src/runner/scheduling";
import type * as Store from "../../src/store";

type Mode = "missing-caption" | "prose" | "fragment" | "cancelled-caption" | "slop-retry" | "self-check-revise" | "self-check-refusal";

const mode = process.argv[2] as Mode;
if (!new Set<Mode>(["missing-caption", "prose", "fragment", "cancelled-caption", "slop-retry", "self-check-revise", "self-check-refusal"]).has(mode)) throw new Error("invalid fixture mode");
const selfCheck = mode === "self-check-revise" || mode === "self-check-refusal";

// Capture util before loading any module that reads ROOT, then replace just its location
// exports. The child process is the boundary: no real output/config/key-state is touched.
const realUtil = await import("../../src/util");
const tempRoot = String(process.env.REDESIGN_TEST_ROOT || "");
const tempHome = String(process.env.REDESIGN_TEST_HOME || "");
if (!tempRoot || !tempHome) throw new Error("missing isolated fixture paths");
mock.module("../../src/util", () => ({ ...realUtil, ROOT: tempRoot, APP_CONFIG_DIR: tempHome, ENV_FILE: path.join(tempHome, ".env") }));

// The self-check modes need renders but not a browser: stand in a renderer that writes a tiny PNG
// and records which viewports were asked for.
const renders: Array<{ width: number; fullPage?: boolean; mobile?: boolean }> = [];
const realThumbnail = await import("../../src/thumbnail");
mock.module("../../src/thumbnail", () => ({
  ...realThumbnail,
  renderHtmlToPng: async (_html: string, outPng: string, size: { width: number; height: number; fullPage?: boolean; mobile?: boolean }) => {
    renders.push({ width: size.width, fullPage: size.fullPage, mobile: size.mobile });
    fs.writeFileSync(outPng, Buffer.from("89504e470d0a1a0a", "hex"));
  },
}));

const [{ KeyManager }, { runOneJob }, { buildJobs }, store] = await Promise.all([
  import("../../src/keyManager"),
  import("../../src/runner/job-worker"),
  import("../../src/runner/scheduling"),
  import("../../src/store"),
]);

let calls = 0;
const requestBodies: string[] = [];
let followUp: { images: number; sawPreviousHtml: boolean } | null = null;
// slop-retry: the first answer trips two P0 anti-slop rules (purple gradient, emoji icons) and the
// re-prompted second answer is clean, so the worker should keep the retry.
const SLOP_HTML =
  '<!DOCTYPE html><html><head><style>.hero{background:linear-gradient(135deg,#7c3aed,#db2777)}</style></head><body><section class="hero"><h1>Dashboard</h1><div>\u{1F680}</div><div>✨</div></section></body></html>';
const CLEAN_HTML = '<!DOCTYPE html><html><head><style>.hero{background:#f4f1ea;color:#1c1b19}</style></head><body><section class="hero"><h1>Dashboard</h1></section></body></html>';
const firstText = mode === "prose" ? "I cannot produce the requested redesign." : mode === "slop-retry" ? SLOP_HTML : "<section><h1>Valid fragment</h1></section>";
const secondText = mode === "slop-retry" ? CLEAN_HTML : mode === "self-check-revise" ? "<section><h1>Revised fragment</h1></section>" : "I will not revise this page.";
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  calls++;
  const body = typeof init?.body === "string" ? init.body : "";
  requestBodies.push(body);
  if (calls === 2 && selfCheck) {
    followUp = { images: body.split("data:image/png;base64,").length - 1, sawPreviousHtml: body.includes("YOUR PREVIOUS HTML") && body.includes("Valid fragment") };
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: calls === 1 ? firstText : secondText }, finish_reason: mode === "prose" ? "length" : "stop" }],
      usage: calls === 1 || !selfCheck ? { prompt_tokens: 12, completion_tokens: 4 } : { prompt_tokens: 50, completion_tokens: 9 },
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
  vision: selfCheck,
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
  imagesFor: () => (selfCheck ? [{ mime: "image/png", data: "iVBORw0KGgo=", bytes: 12, file: "test.png" }] : []),
  describeInput,
  describeReference: async () => null,
  describer: null,
  referenceImages: [],
  referenceRels: [],
  referenceNote: "",
  onProgress: () => {},
  markManifestDirty: () => {},
  selfCheck,
};

await runOneJob(job, ctx);

const output = job.file ? fs.readFileSync(path.join(store.OUTPUT_DIR, job.file), "utf8") : null;
const meta = job.file ? JSON.parse(fs.readFileSync(path.join(store.OUTPUT_DIR, job.file.replace(/\.html$/, ".meta.json")), "utf8")) : null;
const retryPromptHasFindings = (requestBodies[1] || "").includes("purple-gradient");
process.stdout.write(`${JSON.stringify({ calls, job, counts: manifest.counts, output, meta, retryPromptHasFindings, renders, followUp })}\n`);

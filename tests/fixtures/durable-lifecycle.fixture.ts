import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Job, Manifest } from "../../src/store";

const root = String(process.env.REDESIGN_TEST_ROOT || "");
if (!root) throw new Error("missing isolated root");

const fixedPNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const fakeCatalog = {
  models: [{ id: "gemini-flash-latest", label: "Priced fixture model", provider: "gemini", apiModel: "gemini-flash-latest", keyEnv: "DURABLE_FIXTURE_KEYS", baseUrl: "https://fixture.invalid/gemini", vision: true, maxTokens: 32 }],
};
const fakeKeys = "durable-fixture-key";
const mode = process.argv[2];
let fetches = 0;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  fetches++;
  if (mode !== "ledger") throw new Error("provider network must not be called by this fixture");
  const body = JSON.parse(String(init?.body || "{}")) as { generationConfig?: { maxOutputTokens?: number } };
  const maxTokens = body.generationConfig?.maxOutputTokens;
  const text = maxTokens === 48 ? "Ledger fixture" : maxTokens === 1500 ? "A compact fixture screenshot." : "<!DOCTYPE html><html><body>ledger generation</body></html>";
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
}) as unknown as typeof fetch;

const util = await import("../../src/util");
mock.module("../../src/util", () => ({ ...util, ROOT: root, APP_CONFIG_DIR: path.join(root, "home"), ENV_FILE: path.join(root, "home", ".env") }));

const [{ MODELS_FILE, PROMPTS_FILE }, { createApp }, store, queue, { costForUsage }] = await Promise.all([
  import("../../src/config/shared"),
  import("../../src/http/app"),
  import("../../src/store"),
  import("../../src/http/runQueue"),
  import("../../src/runner/cost"),
]);

process.env.DURABLE_FIXTURE_KEYS = fakeKeys;
fs.mkdirSync(path.join(root, "input"), { recursive: true });
fs.writeFileSync(path.join(root, "input", "fixture-input.png"), fixedPNG);
fs.writeFileSync(MODELS_FILE, JSON.stringify(fakeCatalog));
fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ systemContract: "fixture contract", prompts: [{ id: "fixture-prompt", label: "Fixture prompt", user: "Make it durable." }] }));

const app = createApp();
const headers = { "Content-Type": "application/json", Origin: "http://localhost" };
async function post(url: string, body: unknown): Promise<Response> {
  return app.request(url, { method: "POST", headers, body: JSON.stringify(body) });
}
async function create(body: Record<string, unknown>): Promise<string> {
  const response = await post("http://localhost/api/run", body);
  if (!response.ok) throw new Error(`run creation failed: ${response.status} ${await response.text()}`);
  return (await response.json() as { runId: string }).runId;
}
async function settle(runId: string): Promise<Manifest> {
  for (let i = 0; i < 100; i++) {
    const manifest = store.readManifest(runId);
    if (!manifest) throw new Error(`run ${runId} disappeared`);
    if (manifest.status !== "queued" && manifest.status !== "running") return manifest;
    await Bun.sleep(20);
  }
  throw new Error(`run ${runId} did not settle`);
}

const recipe = { inputs: { ids: ["fixture-input"] }, models: { ids: ["gemini-flash-latest"] }, prompts: { presets: ["fixture-prompt"] } };
if (mode === "cancel-queued") {
  const runId = await create({ ...recipe, mock: true, variants: 2, autoStart: false });
  queue.cancelRun(runId);
  const manifest = store.readManifest(runId);
  const retry = await post(`http://localhost/api/runs/${encodeURIComponent(runId)}/retry`, { autoStart: false });
  const result = await retry.json() as { jobCount: number };
  process.stdout.write(`${JSON.stringify({ fetches, jobs: manifest?.jobs, retryStatus: retry.status, jobCount: result.jobCount })}\n`);
} else if (mode === "queue-write") {
  const first = await create({ ...recipe, mock: true, autoStart: false, label: "saved-first" });
  const second = await create({ ...recipe, mock: true, autoStart: false, label: "saved-released" });
  const released = store.readManifest(second);
  if (!released) throw new Error("missing released queue manifest");
  store.writeManifest(second, { ...released, queue: { ...(released.queue as Record<string, unknown>), held: false } });
  process.stdout.write(`${JSON.stringify({ ids: [first, second] })}\n`);
} else if (mode === "queue-recover") {
  const recovered = queue.recoverQueuedRuns();
  const snapshots = [...queue.activeRuns.values()]
    .sort((a, b) => Number((a.lastManifest?.queue as { position?: number } | null)?.position || 0) - Number((b.lastManifest?.queue as { position?: number } | null)?.position || 0))
    .map((entry) => ({ runId: entry.lastManifest?.runId, held: (entry.lastManifest?.queue as { held?: boolean } | null)?.held, jobs: entry.lastManifest?.jobs || [], config: entry.lastManifest?.config }));
  process.stdout.write(`${JSON.stringify({ recovered, fetches, queue: snapshots })}\n`);
} else if (mode === "retry-repeat") {
  const original = await create({ ...recipe, mock: true, variants: 2 });
  const completed = await settle(original);
  const jobs = (completed.jobs || []) as Array<Job & { id?: string; variant?: number }>;
  const failed = jobs.find((job) => job.variant === 2);
  if (!failed) throw new Error("missing second variant");
  failed.status = "error";
  failed.error = "fixture failure";
  store.writeManifest(original, { ...completed, jobs });
  fs.unlinkSync(path.join(root, "input", "fixture-input.png"));
  fs.writeFileSync(MODELS_FILE, JSON.stringify({ models: [] }));
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ systemContract: "", prompts: [] }));
  const retried = await post(`http://localhost/api/runs/${encodeURIComponent(original)}/retry`, { jobIds: [String(failed.id)], autoStart: false });
  const retryBody = await retried.json() as { runIds: string[] };
  const repeated = await post(`http://localhost/api/runs/${encodeURIComponent(original)}/repeat`, { autoStart: false });
  const repeatBody = await repeated.json() as { runId: string };
  const retryManifest = store.readManifest(retryBody.runIds[0]!) as Record<string, unknown>;
  const repeatManifest = store.readManifest(repeatBody.runId) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({ retryStatus: retried.status, retryJobs: retryManifest.jobs, repeatStatus: repeated.status, repeatJobs: repeatManifest.jobs })}\n`);
} else if (mode === "zero-budget") {
  const runId = await create({ ...recipe, maxCostUsd: 0 });
  const manifest = await settle(runId);
  process.stdout.write(`${JSON.stringify({ fetches, status: manifest.status, jobs: manifest.jobs, providerCalls: manifest.providerCalls, cost: manifest.cost })}\n`);
} else if (mode === "ledger") {
  const runId = await create(recipe);
  const manifest = await settle(runId);
  const providerCalls = (manifest.providerCalls || []) as Array<{ purpose?: string }>;
  const expectedCost = costForUsage("gemini-flash-latest", { promptTokenCount: 10, candidatesTokenCount: 5 }).totalCost * 4;
  process.stdout.write(`${JSON.stringify({ fetches, status: manifest.status, purposes: providerCalls.map((call) => call.purpose), jobCount: manifest.cost?.jobCount, totalCost: manifest.cost?.totalCost, expectedCost })}\n`);
} else {
  throw new Error(`invalid mode ${mode}`);
}

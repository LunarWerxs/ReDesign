import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const mode = String(process.argv[2] || "");
if (!new Set(["baseline", "rotation", "reference", "cancelled"]).has(mode)) throw new Error("invalid fixture mode");
const root = String(process.env.REDESIGN_TEST_ROOT || "");
const home = String(process.env.REDESIGN_TEST_HOME || "");
if (!root || !home) throw new Error("missing isolated fixture paths");
type FixtureJob = { modelId: string; file?: string | null };
type FixtureManifest = { jobs: FixtureJob[] };

// Intercept paths before importing application modules that capture ROOT/config locations.
const realUtil = await import("../../src/util");
mock.module("../../src/util", () => ({ ...realUtil, ROOT: root, APP_CONFIG_DIR: home, ENV_FILE: path.join(home, ".env") }));

const [{ MODELS_FILE, PROMPTS_FILE }, { KeyManager }, { runReimagine }, store] = await Promise.all([
  import("../../src/config/shared"), import("../../src/keyManager"), import("../../src/runner"), import("../../src/store"),
]);
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
fs.mkdirSync(path.join(root, "input"), { recursive: true });
fs.mkdirSync(path.join(root, "reference"), { recursive: true });
fs.writeFileSync(path.join(root, "input", "fixture-input.png"), tinyPng);
fs.writeFileSync(path.join(root, "reference", "fixture-reference.png"), tinyPng);
fs.writeFileSync(MODELS_FILE, JSON.stringify({ models: [
  { id: "gemini-flash-latest", label: "Fixture Gemini", provider: "gemini", apiModel: "fixture-gemini", keyEnv: "FIXTURE_GEMINI_KEYS", baseUrl: "https://fixture.invalid/gemini", vision: true, maxTokens: 256 },
  { id: "deepseek-v4-pro", label: "Fixture DeepSeek", provider: "deepseek", apiModel: "fixture-deepseek", keyEnv: "FIXTURE_DEEPSEEK_KEYS", baseUrl: "https://fixture.invalid/deepseek", vision: false, maxTokens: 256 },
  { id: "qwen-3.5-plus", label: "Fixture Qwen", provider: "qwen", apiModel: "fixture-qwen", keyEnv: "FIXTURE_QWEN_KEYS", baseUrl: "https://fixture.invalid/qwen", vision: false, maxTokens: 256 },
] }, null, 2));
fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ systemContract: "Return HTML.", prompts: [
  { id: "faithful-refresh", label: "Faithful", user: "Refresh this interface." },
  { id: "minimalist", label: "Minimal", user: "Make this interface minimal." },
] }, null, 2));
process.env.FIXTURE_GEMINI_KEYS = "fixture-gemini-key";
process.env.FIXTURE_DEEPSEEK_KEYS = "fixture-deepseek-key";
process.env.FIXTURE_QWEN_KEYS = "BADKEY-1,BADKEY-2,fixture-qwen-good-3";
if (mode === "rotation") process.env.MOCK_BAD_SUBSTR = "BADKEY";
const km = new KeyManager({ stateFile: path.join(home, "key-state.json") });
const controller = new AbortController();
if (mode === "cancelled") controller.abort();
const models = mode === "rotation" ? ["qwen-3.5-plus"] : ["gemini-flash-latest", "deepseek-v4-pro"];
const prompts = mode === "baseline" ? ["faithful-refresh", "minimalist"] : ["faithful-refresh"];
const manifest = (await runReimagine({ keyManager: km, mock: true, signal: controller.signal, inputs: { ids: ["fixture-input"] }, models: { ids: models }, prompts: { presets: prompts }, reference: mode === "reference" ? { images: ["fixture-reference.png"], note: "match this palette" } : null, variants: 1, label: `fixture-${mode}` })) as unknown as FixtureManifest;
const metaFor = (modelId: string) => {
  const job = manifest.jobs.find((item) => item.modelId === modelId);
  return job?.file ? JSON.parse(fs.readFileSync(path.join(store.OUTPUT_DIR, job.file.replace(/\.html$/, ".meta.json")), "utf8")) : null;
};
const firstFile = manifest.jobs.find((job) => job.file)?.file;
const firstMeta = metaFor("deepseek-v4-pro") || metaFor("gemini-flash-latest");
const qwenPool = km.snapshot().pools.find((pool) => pool.pool === "FIXTURE_QWEN_KEYS");
process.stdout.write(`${JSON.stringify({ manifest, html: firstFile ? fs.readFileSync(path.join(store.OUTPUT_DIR, firstFile), "utf8") : "", caption: firstMeta?.caption || null, captionBy: firstMeta?.captionBy || null, cooling: qwenPool?.entries.filter((entry) => !entry.availableNow).length || 0, visionReference: metaFor("gemini-flash-latest")?.reference || null, textReference: metaFor("deepseek-v4-pro")?.reference || null })}\n`);

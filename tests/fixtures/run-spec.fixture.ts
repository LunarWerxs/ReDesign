import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = String(process.env.REDESIGN_TEST_ROOT || "");
const home = path.join(root, "home");
if (!root) throw new Error("missing root");
const util = await import("../../src/util");
mock.module("../../src/util", () => ({ ...util, ROOT: root, APP_CONFIG_DIR: home, ENV_FILE: path.join(home, ".env") }));
const [{ MODELS_FILE, PROMPTS_FILE }, { prepareRunSpec, readRunSpec, cloneRunSpec }] = await Promise.all([import("../../src/config/shared"), import("../../src/runner/run-spec")]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
fs.mkdirSync(path.join(root, "input"), { recursive: true }); fs.mkdirSync(path.join(root, "reference"), { recursive: true });
fs.writeFileSync(path.join(root, "input", "source.png"), png); fs.writeFileSync(path.join(root, "reference", "style.png"), png);
fs.writeFileSync(MODELS_FILE, JSON.stringify({ models: [{ id: "vision", label: "Vision", provider: "gemini", apiModel: "vision", keyEnv: "SPEC_VISION_KEYS", baseUrl: "https://invalid", vision: true, maxTokens: 10 }, { id: "text", label: "Text", provider: "deepseek", apiModel: "text", keyEnv: "SPEC_TEXT_KEYS", baseUrl: "https://invalid", vision: false, maxTokens: 10 }] }));
fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ systemContract: "contract", prompts: [{ id: "one", label: "One", user: "one" }] }));
process.env.SPEC_VISION_KEYS = "test-vision-key"; process.env.SPEC_TEXT_KEYS = "test-text-key";
const dir = path.join(root, "spec");
const spec = await prepareRunSpec({ mock: true, inputs: { ids: ["source"] }, models: { ids: ["vision", "text"] }, prompts: { presets: ["one"] }, modelQuantities: { vision: 2 }, reference: { images: ["style.png"], note: "style" } }, dir);
if (process.argv[2] === "clone") {
  fs.unlinkSync(path.join(root, "input", "source.png")); fs.writeFileSync(MODELS_FILE, JSON.stringify({ models: [] }));
  const clone = await cloneRunSpec(dir, path.join(root, "clone"), [spec.jobs[1]!.id]);
  process.stdout.write(`${JSON.stringify({ original: readRunSpec(dir), clone })}\n`);
} else if (process.argv[2] === "corrupt") {
  fs.appendFileSync(path.join(dir, spec.assets[0]!.path), "x");
  process.stdout.write(`${JSON.stringify({ read: readRunSpec(dir) })}\n`);
} else {
  let cap = ""; try { await prepareRunSpec({ inputs: { ids: ["source"] }, models: { ids: ["vision"] }, prompts: { presets: ["one"] }, concurrency: 33 }, path.join(root, "bad")); } catch (error) { cap = (error as Error).message; }
  process.stdout.write(`${JSON.stringify({ spec, cap })}\n`);
}

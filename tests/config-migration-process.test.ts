import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// ROOT is the repo's own root resolver (src/util.ts walks up to the package.json marker). Used here
// instead of process.cwd(), which is merely whichever directory the runner was invoked from: a
// `bun test` started anywhere but the repo root resolved the fixture paths below against the wrong
// base, doubling them into an ENOENT at module scope that killed the whole file.
import { ROOT } from "../src/util";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => { fs.rmSync(root, { recursive: true, force: true }); }));

function boot(root: string): void {
  const result = Bun.spawnSync([process.execPath, "-e", 'import "./src/config/shared.ts"'], {
    cwd: ROOT, env: { ...process.env, REDESIGN_HOME: root }, stderr: "pipe", stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

test("an unchanged profile import performs no config writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-config-migrate-")); roots.push(root);
  boot(root);
  const config = path.join(root, "config");
  const files = ["models.json", "prompts.json", "prompts.defaults.json", ".reimagine-shipped-baseline.json"];
  const baseline = JSON.parse(fs.readFileSync(path.join(config, ".reimagine-shipped-baseline.json"), "utf8"));
  expect(baseline.version).toBe(1);
  expect(typeof baseline.revision).toBe("string");
  const before = Object.fromEntries(files.map((file) => [file, fs.statSync(path.join(config, file)).mtimeMs]));
  boot(root);
  expect(Object.fromEntries(files.map((file) => [file, fs.statSync(path.join(config, file)).mtimeMs]))).toEqual(before);
  expect(fs.existsSync(path.join(config, ".reimagine-config.lock"))).toBe(false);
}, 60_000);

test("upgrade migration keeps a custom model and archived tombstone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-config-upgrade-")); roots.push(root);
  boot(root);
  const config = path.join(root, "config");
  const modelsPath = path.join(config, "models.json");
  const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  const archived = models.models[0];
  models.models[0] = { ...models.models[0], label: "My edited label" };
  models.models = models.models.filter((m: { id: string }) => m.id !== archived.id);
  models.models.push({ ...archived, id: "custom-model", label: "Custom" });
  models.modelArchive = [archived];
  fs.writeFileSync(modelsPath, JSON.stringify(models));
  const baselinePath = path.join(config, ".reimagine-shipped-baseline.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")); baseline.revision = "old";
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));
  boot(root);
  const upgraded = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  expect(upgraded.models.find((m: { id: string }) => m.id === "custom-model")?.label).toBe("Custom");
  expect(upgraded.models.some((m: { id: string }) => m.id === archived.id)).toBe(false);
}, 60_000);

test("a baseline-free 1.6.6 profile upgrades exact shipped records and preserves edited records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-config-legacy-")); roots.push(root);
  boot(root);
  const config = path.join(root, "config");
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, "src/config/legacy-shipped.json"), "utf8"));
  const modelsPath = path.join(config, "models.json");
  const legacyModels = legacy.models;
  legacyModels.models[1] = { ...legacyModels.models[1], label: "Personal label" };
  fs.writeFileSync(modelsPath, JSON.stringify(legacyModels));
  fs.writeFileSync(path.join(config, "prompts.json"), JSON.stringify(legacy.prompts));
  fs.rmSync(path.join(config, ".reimagine-shipped-baseline.json"));
  boot(root);
  const result = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  expect(result.models.find((m: { id: string }) => m.id === "claude-opus-5")).toBeTruthy();
  expect(result.models.find((m: { id: string }) => m.id === "gpt-5.5")?.label).toBe("Personal label");
}, 60_000);

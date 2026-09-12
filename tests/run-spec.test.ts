import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => { fs.rmSync(root, { recursive: true, force: true }); }));
function fixture(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-run-spec-")); roots.push(root);
  const proc = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "fixtures", "run-spec.fixture.ts"), mode], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, REDESIGN_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}
describe("run specs", () => {
  it("snapshots durable selected assets and rejects hard concurrency caps", () => { const result = fixture("base"); expect(result.spec.jobs).toHaveLength(3); expect(result.spec.assets).toHaveLength(2); expect(result.spec.inputs[0].images[0]).toMatch(/^assets\/input\//); expect(result.cap).toContain("concurrency"); }, 60_000);
  it("clones an exact original variant after source catalog and input disappear", () => { const result = fixture("clone"); expect(result.clone.jobs).toHaveLength(1); expect(result.clone.jobs[0].variant).toBe(2); expect(result.clone.models).toHaveLength(1); expect(result.clone.assets).toHaveLength(2); }, 60_000);
  it("rejects a spec whose copied asset was corrupted", () => { expect(fixture("corrupt").read).toBeNull(); }, 60_000);
});

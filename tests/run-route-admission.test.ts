import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const roots: string[] = [];
afterAll(() => roots.forEach((root) => { fs.rmSync(root, { recursive: true, force: true }); }));
function request(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-route-admission-")); roots.push(root);
  const proc = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "fixtures", "run-route-admission.fixture.ts"), mode], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, REDESIGN_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}
describe("POST /api/run admission", () => {
  it("returns 400 for malformed JSON instead of queuing default work", () => expect(request("malformed").status).toBe(400), 60_000);
  it("returns 400 for null, array, and unknown explicit selections", () => expect(request("invalid").statuses).toEqual([400, 400, 400, 400, 400]), 60_000);
  it("admits a held custom recipe from an isolated catalog", () => { const result = request("custom"); expect(result.status).toBe(200); expect(result.manifest.status).toBe("queued"); expect(result.manifest.queue.held).toBe(true); expect(result.manifest.config.promptIds).toEqual(["custom"]); }, 60_000);
  it("consumes a preflight snapshot once even after its source catalog changes", () => { const result = request("preflight"); expect(result.first).toBe(result.second); expect(result.jobs).toEqual(["model:preset"]); expect(result.input).toMatch(/^assets\/input\//); }, 60_000);
});

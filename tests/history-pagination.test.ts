import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const fixture = path.join(import.meta.dir, "fixtures", "history-pagination.fixture.ts");

// Deleting the fixture roots is synchronous and can pass bun's 5 s hook default on a loaded box,
// which reports the whole file as "a beforeEach/afterEach hook timed out" (harvest F, 2026-09-25).
afterAll(() => {
  roots.forEach((root) => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}, 60_000);

function runFixture(mode: string, count?: number): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-history-pagination-"));
  roots.push(root);
  const args = [process.execPath, fixture, mode];
  if (count != null) args.push(String(count));
  const proc = Bun.spawnSync(args, {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, REDESIGN_TEST_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (proc.exitCode !== 0) throw new Error(`fixture ${mode} failed:\n${proc.stderr.toString()}\n${proc.stdout.toString()}`);
  return JSON.parse(proc.stdout.toString()) as Record<string, unknown>;
}

describe("run history pagination", () => {
  for (const count of [499, 500, 501, 3000]) {
    it(`keeps the recent summary cache warm across ${count} runs`, () => {
      const result = runFixture("history", count) as { firstReads: number; secondReads: number; pageReads: number; total: number; pageTotal: number };
      expect(result.firstReads).toBe(count);
      expect(result.total).toBe(count);
      expect(result.secondReads).toBeLessThanOrEqual(count === 501 ? 1 : count === 3000 ? 2500 : 0);
      expect(result.pageReads).toBe(0);
      expect(result.pageTotal).toBe(50);
    }, 60_000);
  }

  it("returns every valid run once through cursors while ignoring private and invalid entries", () => {
    const result = runFixture("pages") as { total: number; ids: string[]; pageLengths: number[]; exhausted: unknown[]; privateSeen: boolean };
    expect(result.total).toBe(125);
    expect(new Set(result.ids).size).toBe(125);
    expect(result.pageLengths).toEqual([50, 50, 25]);
    expect(result.exhausted).toEqual([]);
    expect(result.privateSeen).toBe(false);
  }, 60_000);
});

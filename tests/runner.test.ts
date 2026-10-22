import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = path.join(import.meta.dir, "fixtures", "runner-isolated.fixture.ts");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function runFixture(mode: string): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-runner-fixture-"));
  roots.push(root);
  const proc = Bun.spawnSync([process.execPath, fixture, mode], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, REDESIGN_TEST_ROOT: root, REDESIGN_TEST_HOME: path.join(root, "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`fixture ${mode} failed:\n${proc.stderr.toString()}\n${proc.stdout.toString()}`);
  return JSON.parse(proc.stdout.toString()) as Record<string, unknown>;
}

type FixtureJob = { modelId: string; promptId: string; status: string; attempts: number; note?: string | null; file?: string | null };
type FixtureManifest = { status: string; counts: { total: number; done: number; ok: number; skipped: number }; jobs: FixtureJob[]; config: { grounded?: boolean; reference?: { count: number } | null } };

describe("runner: isolated mock batches", () => {
  it("runs the fixed model and prompt matrix with grounded captions and HTML sidecars", () => {
    const result = runFixture("baseline");
    const manifest = result.manifest as FixtureManifest;
    expect(manifest.status).toBe("done");
    expect(manifest.counts).toMatchObject({ total: 4, done: 4, ok: 4, skipped: 0 });
    expect(manifest.jobs.map((job) => `${job.modelId}:${job.promptId}`).sort()).toEqual([
      "deepseek-v4-pro:faithful-refresh", "deepseek-v4-pro:minimalist",
      "gemini-flash-latest:faithful-refresh", "gemini-flash-latest:minimalist",
    ]);
    expect(manifest.config.grounded).toBe(true);
    expect((result.html as string).includes("<!DOCTYPE html>")).toBe(true);
    expect((result.html as string).length).toBeGreaterThan(200);
    expect(result.caption).toBe("[mock caption of fixture-input.png]");
    expect(result.captionBy).toBe("gemini-flash-latest");
  }, 60_000);

  it("rotates past two injected bad keys using an isolated Qwen pool", () => {
    const result = runFixture("rotation");
    const manifest = result.manifest as FixtureManifest;
    expect(manifest.status).toBe("done");
    expect(manifest.jobs).toHaveLength(1);
    expect(manifest.jobs[0]).toMatchObject({ modelId: "qwen-3.5-plus", status: "ok", attempts: 3 });
    expect(result.cooling).toBe(2);
  }, 60_000);

  it("carries the fixed reference through vision and text-only jobs", () => {
    const result = runFixture("reference");
    const manifest = result.manifest as FixtureManifest;
    expect(manifest.status).toBe("done");
    expect(manifest.config.reference?.count).toBe(1);
    expect(result.visionReference).toMatchObject({ note: "match this palette", caption: null });
    expect((result.visionReference as { images: string[] }).images[0]).toMatch(/^assets\/reference\//);
    expect(result.textReference).toMatchObject({
      note: "match this palette",
      caption: "[mock style caption of 1 reference image(s)]", captionBy: "gemini-flash-latest",
    });
  }, 60_000);

  it("marks every selected job cancelled before any provider work begins", () => {
    const result = runFixture("cancelled");
    const manifest = result.manifest as FixtureManifest;
    expect(manifest.status).toBe("cancelled");
    expect(manifest.counts).toMatchObject({ total: 2, done: 2, ok: 0, skipped: 2 });
    expect(manifest.jobs.map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
  }, 60_000);
});

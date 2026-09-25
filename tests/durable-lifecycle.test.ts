import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const fixture = path.join(import.meta.dir, "fixtures", "durable-lifecycle.fixture.ts");

afterAll(() => {
  roots.forEach((root) => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

function runFixture(root: string, mode: string): Record<string, unknown> {
  const proc = Bun.spawnSync([process.execPath, fixture, mode], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, REDESIGN_TEST_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  if (proc.exitCode !== 0) throw new Error(`fixture ${mode} failed:\n${proc.stderr.toString()}\n${proc.stdout.toString()}`);
  return JSON.parse(proc.stdout.toString()) as Record<string, unknown>;
}

function newRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-durable-lifecycle-"));
  roots.push(root);
  return root;
}

describe("durable run lifecycle", () => {
  it("keeps every cancelled held job retryable without admitting provider calls", () => {
    const result = runFixture(newRoot(), "cancel-queued") as { fetches: number; jobs: Array<{ status: string }>; retryStatus: number; jobCount: number };
    expect(result.fetches).toBe(0);
    expect(result.jobs.every((job) => job.status === "cancelled")).toBe(true);
    expect(result.retryStatus).toBe(200);
    expect(result.jobCount).toBe(2);
  }, 60_000);
  it("recovers interrupted queued recipes as held snapshots in their saved order without provider calls", () => {
    const root = newRoot();
    const created = runFixture(root, "queue-write") as { ids: string[] };
    const recovered = runFixture(root, "queue-recover") as { recovered: number; fetches: number; queue: Array<{ runId: string; held?: boolean; jobs: unknown[]; config: unknown }> };

    expect(recovered.recovered).toBe(2);
    expect(recovered.fetches).toBe(0);
    expect(recovered.queue.map((run) => run.runId)).toEqual(created.ids);
    expect(recovered.queue.every((run) => run.held === true && run.jobs.length === 1 && run.config)).toBe(true);
  }, 60_000);

  it("retries one failed saved variant and repeats the complete saved recipe after live sources disappear", () => {
    const result = runFixture(newRoot(), "retry-repeat") as {
      retryStatus: number;
      retryJobs: Array<{ id: string; variant: number; status: string; inputId: string; modelId: string; promptId: string }>;
      repeatStatus: number;
      repeatJobs: Array<{ variant: number; inputId: string; modelId: string; promptId: string }>;
    };

    expect(result.retryStatus).toBe(200);
    expect(result.retryJobs).toHaveLength(1);
    expect(result.retryJobs[0]).toMatchObject({ variant: 2, inputId: "fixture-input", modelId: "gemini-flash-latest", promptId: "fixture-prompt", status: "pending" });
    expect(result.repeatStatus).toBe(200);
    expect(result.repeatJobs.map((job) => job.variant)).toEqual([1, 2]);
    expect(result.repeatJobs.every((job) => job.inputId === "fixture-input" && job.modelId === "gemini-flash-latest" && job.promptId === "fixture-prompt")).toBe(true);
  }, 60_000);

  it("stops a zero-budget live run before any provider request or ledger charge", () => {
    const result = runFixture(newRoot(), "zero-budget") as { fetches: number; status: string; jobs: Array<{ status: string }>; providerCalls: unknown[]; cost: { totalCost: number } };

    expect(result.fetches).toBe(0);
    expect(result.status).toBe("done");
    expect(result.jobs.every((job) => job.status === "error" || job.status === "skipped")).toBe(true);
    expect(result.providerCalls).toHaveLength(0);
    expect(result.cost.totalCost).toBe(0);
  }, 60_000);

  it("records every billed helper and generation call exactly once in the live-run ledger", () => {
    const result = runFixture(newRoot(), "ledger") as { fetches: number; status: string; purposes: string[]; jobCount: number; totalCost: number; expectedCost: number };

    // The input's logo/photo detection (runner/asset-crop.ts) is a billed helper call too.
    expect(result.fetches).toBe(4);
    expect(result.status).toBe("done");
    expect(result.purposes.sort()).toEqual(["asset_crop", "caption", "generation", "title"]);
    expect(result.jobCount).toBe(4);
    expect(result.totalCost).toBe(result.expectedCost);
  }, 60_000);
});

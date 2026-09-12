import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(import.meta.dir, "..");
const fixture = path.join(appRoot, "tests", "fixtures", "job-worker-boundary.fixture.ts");

interface FixtureResult {
  calls: number;
  job: { status: string; attempts: number; error: string | null; wrapped: boolean; truncated?: boolean; note?: string; usage: unknown };
  counts: { total: number; done: number; ok: number; error: number; skipped: number };
  output: string | null;
  meta: Record<string, unknown> | null;
}

function runFixture(mode: "missing-caption" | "prose" | "fragment" | "cancelled-caption"): FixtureResult {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-job-worker-"));
  try {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, fixture, mode],
      cwd: appRoot,
      env: {
        ...process.env,
        REDESIGN_TEST_ROOT: path.join(temp, "root"),
        REDESIGN_TEST_HOME: path.join(temp, "home"),
        REDESIGN_TEST_KEY_STATE: path.join(temp, "keys.json"),
        __TEST_TEXT_ONLY_KEYS__: "first-test-key,second-test-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    return JSON.parse(new TextDecoder().decode(proc.stdout)) as FixtureResult;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe("job worker prerequisites and output validation", () => {
  it("does not call a provider when a text-only screenshot caption is unavailable", () => {
    const result = runFixture("missing-caption");

    expect(result.calls).toBe(0);
    expect(result.job.status).toBe("skipped");
    expect(result.job.attempts).toBe(0);
    expect(result.job.error).toMatch(/screenshot caption.*required/i);
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 0, error: 0, skipped: 1 });
  }, 60_000);

  it("keeps one billed prose diagnostic but marks it as an output error without retrying another key", () => {
    const result = runFixture("prose");

    expect(result.calls).toBe(1);
    expect(result.job.attempts).toBe(1);
    expect(result.job.status).toBe("error");
    expect(result.job.error).toBe("model returned no HTML output");
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 0, error: 1, skipped: 0 });
    expect(result.output).toContain("I cannot produce the requested redesign.");
    expect(result.meta?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4 });
    expect(result.meta?.extraction).toBe("non-html");
    expect(result.job.truncated).toBe(true);
    expect(result.job.note).toMatch(/truncated/i);
  }, 60_000);

  it("accepts a valid wrapped fragment as a successful output", () => {
    const result = runFixture("fragment");

    expect(result.calls).toBe(1);
    expect(result.job.status).toBe("ok");
    expect(result.job.wrapped).toBe(true);
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 1, error: 0, skipped: 0 });
    expect(result.meta?.extraction).toBe("fragment");
  }, 60_000);

  it("keeps a caption-time cancellation cancelled instead of converting it to a prerequisite skip", () => {
    const result = runFixture("cancelled-caption");

    expect(result.calls).toBe(0);
    expect(result.job.status).toBe("cancelled");
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 0, error: 0, skipped: 1 });
  }, 60_000);
});

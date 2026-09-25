import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/util";

// ROOT is the repo's own resolver (src/util.ts walks up to the package.json marker) rather than a
// hop-count from this file's own directory, which rots silently if the file or tests/ moves: the
// fixture would then not be found, the spawn would report nothing, and a bare exit code would read
// as a pass.
const fixture = path.join(ROOT, "tests", "fixtures", "job-worker-boundary.fixture.ts");

interface FixtureResult {
  calls: number;
  job: { status: string; attempts: number; error: string | null; wrapped: boolean; truncated?: boolean; note?: string; usage: unknown };
  counts: { total: number; done: number; ok: number; error: number; skipped: number };
  output: string | null;
  meta: Record<string, unknown> | null;
  renders: Array<{ width: number; fullPage?: boolean; mobile?: boolean }>;
  followUp: { images: number; sawPreviousHtml: boolean } | null;
}

function runFixture(mode: "missing-caption" | "prose" | "fragment" | "cancelled-caption" | "self-check-revise" | "self-check-refusal"): FixtureResult {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-job-worker-"));
  try {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, fixture, mode],
      cwd: ROOT,
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

// Contract: with self-check on, a successful output is rendered at desktop and phone width and
// the model gets ONE follow-up carrying the original, both renders and its own HTML; a clean
// revision replaces the output, anything else restores the first one and the job stays ok.
describe("job worker self-check pass", () => {
  it("sends the original plus desktop and phone renders with the previous HTML, and keeps the revision", () => {
    const result = runFixture("self-check-revise");

    expect(result.calls).toBe(2);
    expect(result.renders).toEqual([
      { width: 1440, fullPage: true, mobile: false },
      { width: 390, fullPage: true, mobile: true },
    ]);
    expect(result.followUp).toEqual({ images: 3, sawPreviousHtml: true });
    expect(result.job.status).toBe("ok");
    expect(result.output).toContain("Revised fragment");
    expect((result.job as { selfCheck?: { status: string } }).selfCheck?.status).toBe("revised");
    // Per-job usage stays the first generation's so history-based estimates compare like with like.
    expect(result.job.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4 });
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 1, error: 0, skipped: 0 });
  }, 60_000);

  it("restores the first output byte for byte when the revision is not HTML, and never fails the job", () => {
    const result = runFixture("self-check-refusal");

    expect(result.calls).toBe(2);
    expect(result.job.status).toBe("ok");
    expect(result.job.error).toBeNull();
    expect(result.output).toContain("Valid fragment");
    expect(result.output).not.toContain("will not revise");
    expect(result.meta?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4 });
    expect((result.job as { selfCheck?: { status: string } }).selfCheck?.status).toBe("kept");
    expect(result.counts).toEqual({ total: 1, done: 1, ok: 1, error: 0, skipped: 0 });
  }, 60_000);
});

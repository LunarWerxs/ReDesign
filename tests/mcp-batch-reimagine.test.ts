import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/http/app";
import * as store from "../src/store";
import * as inputResolver from "../src/inputResolver";
import { TOOLS } from "../src/mcp/tools";

// TOOLS entries return Promise<unknown> (see src/mcp/tools.ts); these mirror the runtime shapes
// this suite actually receives so the `as X` casts below stay honest instead of reaching for `any`.
interface BatchQueuedResult {
  runId: string;
  note: string;
  jobs?: unknown; // absent on the wait:false path; asserted below
}

interface RunManifestStatus {
  status: string;
}

interface BatchDigestJob {
  input: string;
  model: string;
  prompt: string;
  variant: number;
  status: string;
  outputFile: string | null;
  caption: string | null;
  error: string | null;
}

interface BatchDigest {
  runId: string;
  status: string;
  jobs: BatchDigestJob[];
  captionSummary: string;
}

// Boot a real Bun.serve instance on an ephemeral port and point the MCP tool table's HTTP
// client at it via REDESIGN_URL (see src/mcp/tools.ts's base()). This exercises batch_reimagine
// exactly as an MCP client would call it, through the tool table, over real HTTP, without
// needing a stdio subprocess: handleRpc()/the tools themselves are already pure enough that a
// direct TOOLS.find(...).run(args) call is a faithful "tools/call" round trip.
/** A 1x1 PNG, the same inline fixture tests/inputResolver.test.ts uses - no committed binary. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("MCP tool: batch_reimagine", () => {
  let server: ReturnType<typeof Bun.serve>;
  const createdRunIds: string[] = [];

  beforeAll(() => {
    const app = createApp();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    process.env.REDESIGN_URL = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    delete process.env.REDESIGN_URL;
    delete process.env.REDESIGN_INPUT_DIR;
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    server.stop(true);
    for (const runId of createdRunIds) {
      try {
        fs.rmSync(store.runDir(runId), { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  });

  function tool(name: string) {
    const t = TOOLS.find((t) => t.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  }

  // ⛔ THIS SUITE USED TO NEED A SUBJECT THE REPO DOES NOT SHIP, AND SO IT NEVER RAN IN CI
  // (2026-09-18). `input/` is untracked: on a clean checkout `listInputs()` is empty, so these
  // cases either failed outright (a `400 No inputs matched the selection` that held main red for
  // three runs) or, once guarded, skipped - zero coverage wearing a green tick, on the tool that
  // drives every batch. They now BUILD their own subject, the same way tests/inputResolver.test.ts
  // already does, and point the server at it with REDESIGN_INPUT_DIR (see currentInputDir). A
  // fixture the suite creates is the only kind that is there on every machine.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-mcp-batch-input-"));
  fs.writeFileSync(path.join(fixtureDir, "Fixture Subject.png"), TINY_PNG);
  process.env.REDESIGN_INPUT_DIR = fixtureDir;
  const realInputs = inputResolver.listInputs();

  // ⛔ TWO DIFFERENT PRECONDITIONS, AND CONFLATING THEM IS WHAT HID THE BUG. A subject is now
  // guaranteed by the fixture above, so `it` is unconditional for anything that only needs one -
  // a skip there would mean something is genuinely wrong. But GENERATING requires API KEYS: even
  // under `mock: true` the runner acquires from the model's key pool first and marks a keyless job
  // `skipped` ("no API keys configured for <keyEnv>"), so any case asserting `status === "ok"`
  // cannot pass on a machine without them. CI has no `.env`. Guarding those on the keys they
  // actually need - rather than on inputs, which was never the real requirement - is what lets the
  // keyless case RUN everywhere instead of the whole file skipping.
  const hasKeys = (...envs: string[]): boolean => envs.every((e) => !!process.env[e]?.trim());
  const GENERATION_KEYS = ["GEMINI_FLASH_API_KEYS", "QWEN_API_KEYS"];
  const maybeIt = hasKeys(...GENERATION_KEYS) ? it : it.skip;

  // UNCONDITIONAL: this case only needs a SUBJECT (the fixture guarantees one) and never a key -
  // it asserts the shape of the queued reply, not a generated image. It is also the case that held
  // main red on all three platforms from 2026-09-17 21:16, because it used to carry an
  // `inputs: "all"` fallback that matches nothing on a clean checkout. Three platforms failing
  // identically is never flake: it is a fixture the repo does not ship, and a test that "works on
  // my machine" only because of untracked local state is lying about what it covers.
  it("wait:false returns { runId, note } immediately without a status field", async () => {
    const result = (await tool("batch_reimagine").run({
      inputs: realInputs[0]!.id,
      models: "gemini-flash-latest",
      prompts: "faithful-refresh",
      mock: true,
      label: "mcp-batch-nowait",
    })) as BatchQueuedResult;
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(typeof result.note).toBe("string");
    expect(result.jobs).toBeUndefined();
    createdRunIds.push(result.runId);

    // Let the queued mock run actually finish before the suite ends (it's fast under mock).
    for (let i = 0; i < 40; i++) {
      const manifest = (await tool("get_run").run({ runId: result.runId })) as RunManifestStatus;
      if (manifest.status !== "queued" && manifest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  maybeIt(
    "wait:true polls to completion and returns a structured digest with per-job caption/outputFile",
    async () => {
      const digest = (await tool("batch_reimagine").run({
        inputs: realInputs[0]!.id,
        models: "gemini-flash-latest,kimi-k3",
        prompts: "faithful-refresh",
        mock: true,
        wait: true,
        timeout_secs: 60,
        label: "mcp-batch-wait",
      })) as BatchDigest;
      createdRunIds.push(digest.runId);

      expect(digest.status).toBe("done");
      expect(Array.isArray(digest.jobs)).toBe(true);
      expect(digest.jobs.length).toBe(2);
      expect(typeof digest.captionSummary).toBe("string");

      for (const j of digest.jobs) {
        expect(j.status).toBe("ok");
        expect(typeof j.outputFile).toBe("string");
        expect(j.error).toBeNull();
      }

      // kimi-k3 is text-only in models.json, the runner captions the input for it, and
      // the caption lands in the job's .meta.json sidecar (src/runner/reimagine.ts). Confirm the
      // digest surfaces it via the /output-raw/*.meta.json read path.
      const textJob = digest.jobs.find((j) => j.model === "kimi-k3");
      expect(textJob).toBeTruthy();
      if (!textJob) throw new Error("kimi-k3 job not found in digest.jobs");
      const textCaption = textJob.caption;
      expect(typeof textCaption).toBe("string");
      if (typeof textCaption !== "string") throw new Error("expected kimi-k3 caption to be a string");
      expect(textCaption.length).toBeGreaterThan(0);
      expect(/1\/2|2\/2/.test(digest.captionSummary)).toBe(true);

      // Sanity: the manifest this digest was built from is really on disk.
      const manifestPath = path.join(store.OUTPUT_DIR, digest.runId, "manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);
    },
  );

  maybeIt("wait:true honors a short timeout and can return before the run finishes", async () => {
    // Not asserting incompleteness (mock runs are fast and may finish inside any timeout), just
    // that a tiny timeout doesn't throw and still returns a well-shaped digest either way.
    const digest = (await tool("batch_reimagine").run({
      inputs: realInputs[0]!.id,
      models: "gemini-flash-latest",
      prompts: "faithful-refresh",
      mock: true,
      wait: true,
      timeout_secs: 1,
      label: "mcp-batch-shorttimeout",
    })) as BatchDigest;
    createdRunIds.push(digest.runId);
    expect(typeof digest.runId).toBe("string");
    expect(["queued", "running", "done"]).toContain(digest.status);
    expect(Array.isArray(digest.jobs)).toBe(true);
  });
});

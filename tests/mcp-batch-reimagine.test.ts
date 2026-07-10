import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/http/app";
import * as store from "../src/store";
import * as inputResolver from "../src/inputResolver";
import { TOOLS } from "../src/mcp/tools";

// Boot a real Bun.serve instance on an ephemeral port and point the MCP tool table's HTTP
// client at it via REDESIGN_URL (see src/mcp/tools.ts's base()). This exercises batch_reimagine
// exactly as an MCP client would call it, through the tool table, over real HTTP, without
// needing a stdio subprocess: handleRpc()/the tools themselves are already pure enough that a
// direct TOOLS.find(...).run(args) call is a faithful "tools/call" round trip.
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

  const realInputs = inputResolver.listInputs();
  const maybeIt = realInputs.length ? it : it.skip;

  it("wait:false returns { runId, note } immediately without a status field", async () => {
    const result = (await tool("batch_reimagine").run({
      inputs: realInputs.length ? realInputs[0]!.id : "all",
      models: "gemini-3.5-flash",
      prompts: "faithful-refresh",
      mock: true,
      label: "mcp-batch-nowait",
    })) as { runId: string; note: string };
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(typeof result.note).toBe("string");
    expect((result as any).jobs).toBeUndefined();
    createdRunIds.push(result.runId);

    // Let the queued mock run actually finish before the suite ends (it's fast under mock).
    for (let i = 0; i < 40; i++) {
      const manifest = (await tool("get_run").run({ runId: result.runId })) as any;
      if (manifest.status !== "queued" && manifest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  maybeIt(
    "wait:true polls to completion and returns a structured digest with per-job caption/outputFile",
    async () => {
      const digest = (await tool("batch_reimagine").run({
        inputs: realInputs[0]!.id,
        models: "gemini-3.5-flash,deepseek-v4-pro",
        prompts: "faithful-refresh",
        mock: true,
        wait: true,
        timeout_secs: 60,
        label: "mcp-batch-wait",
      })) as any;
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

      // deepseek-v4-pro is text-only in models.json, the runner captions the input for it, and
      // the caption lands in the job's .meta.json sidecar (src/runner/reimagine.ts). Confirm the
      // digest surfaces it via the /output-raw/*.meta.json read path.
      const dsJob = digest.jobs.find((j: any) => j.model === "deepseek-v4-pro");
      expect(dsJob).toBeTruthy();
      expect(typeof dsJob.caption).toBe("string");
      expect(dsJob.caption.length).toBeGreaterThan(0);
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
      models: "gemini-3.5-flash",
      prompts: "faithful-refresh",
      mock: true,
      wait: true,
      timeout_secs: 1,
      label: "mcp-batch-shorttimeout",
    })) as any;
    createdRunIds.push(digest.runId);
    expect(typeof digest.runId).toBe("string");
    expect(["queued", "running", "done"]).toContain(digest.status);
    expect(Array.isArray(digest.jobs)).toBe(true);
  });
});

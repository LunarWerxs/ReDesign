import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyManager } from "../src/keyManager";
import * as inputResolver from "../src/inputResolver";
import * as store from "../src/store";
import { runReimagine } from "../src/runner";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("runner: end-to-end mock run with key rotation", () => {
  const tmpState = path.join(os.tmpdir(), "reimagine-test-runner-" + process.pid + ".json");

  afterAll(() => {
    for (const suffix of [".e2e", ".e2e2", ".rot", ".ref"]) {
      try { fs.unlinkSync(tmpState + suffix); } catch (_) {}
    }
  });

  it("rejects an empty input selection clearly", async () => {
    const e2eKm = new KeyManager({ stateFile: tmpState + ".e2e" });
    const manifest: any = await runReimagine({
      keyManager: e2eKm,
      mock: true,
      inputs: { ids: ["__nonexistent-input-id__"] },
      models: { ids: ["gemini-3.5-flash", "deepseek-v4-pro"] },
      prompts: { presets: ["faithful-refresh"] },
      variants: 1,
      label: "selftest",
    }).catch((e: Error) => ({ error: e.message }));
    expect(manifest.error).toBeTruthy();
    expect(/No inputs/.test(manifest.error)).toBe(true);
  });

  const realInputs = inputResolver.listInputs();
  const maybeIt = realInputs.length ? it : it.skip;

  maybeIt("clean mock run over real input/: every job succeeds and produces a valid HTML file + sidecar meta", async () => {
    const e2eKm2 = new KeyManager({ stateFile: tmpState + ".e2e2" });
    const m2: any = await runReimagine({
      keyManager: e2eKm2,
      mock: true,
      inputs: { ids: [realInputs[0]!.id] },
      models: { ids: ["gemini-3.5-flash", "deepseek-v4-pro", "claude-opus-4-8"] },
      prompts: { presets: ["faithful-refresh", "minimalist"] },
      variants: 1,
      label: "selftest",
    });
    try {
      expect(m2.counts.done).toBe(m2.counts.total);
      expect(m2.counts.ok).toBe(m2.counts.total);
      expect(m2.status).toBe("done");

      const dsJob = m2.jobs.find((j: any) => j.modelId === "deepseek-v4-pro");
      expect(dsJob).toBeTruthy();
      expect(/caption/i.test(dsJob.note || "")).toBe(true);

      if (dsJob?.file) {
        const metaPath = path.join(store.OUTPUT_DIR, dsJob.file.replace(/\.html$/, ".meta.json").split("/").join(path.sep));
        const dsMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        expect(!!dsMeta.caption).toBe(true);
        expect(!!dsMeta.captionBy).toBe(true);
      }

      const okJob = m2.jobs.find((j: any) => j.status === "ok");
      const file = path.join(store.OUTPUT_DIR, okJob.file.split("/").join(path.sep));
      const html = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      expect(html.includes("<!DOCTYPE html>")).toBe(true);
      expect(html.length).toBeGreaterThan(200);
      expect(fs.existsSync(file.replace(/\.html$/, ".meta.json"))).toBe(true);
    } finally {
      try { fs.rmSync(store.runDir(m2.runId), { recursive: true, force: true }); } catch (_) {}
    }
  });

  maybeIt("rotation: succeeds after skipping 2 known-bad keys, and those keys are now cooling", async () => {
    process.env.MOCK_BAD_SUBSTR = "BADKEY";
    process.env.QWEN_API_KEYS = "BADKEY-1,BADKEY-2,good-3,good-4";
    const rotKm = new KeyManager({ stateFile: tmpState + ".rot" });
    const mr: any = await runReimagine({
      keyManager: rotKm,
      mock: true,
      inputs: { ids: [realInputs[0]!.id] },
      models: { ids: ["qwen-3.5-plus"] },
      prompts: { presets: ["minimalist"] },
      variants: 1,
      label: "rot",
    });
    delete process.env.MOCK_BAD_SUBSTR;
    try {
      const rjob = mr.jobs[0];
      expect(rjob.status).toBe("ok");
      expect(rjob.attempts).toBe(3);
      expect(rotKm.snapshot().pools[0]!.entries.filter((e) => !e.availableNow).length).toBe(2);
    } finally {
      try { fs.rmSync(store.runDir(mr.runId), { recursive: true, force: true }); } catch (_) {}
    }
  });

  maybeIt("style reference rides along with every job: vision job records it, text-only job gets a described reference", async () => {
    const refFile = path.join(inputResolver.REFERENCE_DIR, "__selftest_ref.png");
    let refMade = false;
    try {
      fs.mkdirSync(inputResolver.REFERENCE_DIR, { recursive: true });
      fs.writeFileSync(refFile, TINY_PNG);
      refMade = true;
    } catch (_) {}
    if (!refMade) return;

    const refKm = new KeyManager({ stateFile: tmpState + ".ref" });
    const mref: any = await runReimagine({
      keyManager: refKm,
      mock: true,
      inputs: { ids: [realInputs[0]!.id] },
      models: { ids: ["gemini-3.5-flash", "deepseek-v4-pro"] },
      prompts: { presets: ["material-3"] },
      reference: { images: ["__selftest_ref.png"], note: "match this palette" },
      variants: 1,
      label: "reftest",
    });
    try {
      expect(mref.config.reference?.count).toBe(1);
      const metaOf = (j: any) =>
        JSON.parse(fs.readFileSync(path.join(store.OUTPUT_DIR, j.file.replace(/\.html$/, ".meta.json").split("/").join(path.sep)), "utf8"));
      const visJob = mref.jobs.find((j: any) => j.modelId === "gemini-3.5-flash" && j.status === "ok");
      const txtJob = mref.jobs.find((j: any) => j.modelId === "deepseek-v4-pro" && j.status === "ok");
      if (visJob) {
        const mm = metaOf(visJob);
        expect(mm.reference?.images.includes("__selftest_ref.png")).toBe(true);
        expect(mm.reference?.note).toBe("match this palette");
      }
      if (txtJob) {
        const mm = metaOf(txtJob);
        expect(!!mm.reference?.caption).toBe(true);
      }
    } finally {
      try { fs.rmSync(store.runDir(mref.runId), { recursive: true, force: true }); } catch (_) {}
      try { fs.unlinkSync(refFile); } catch (_) {}
    }
  });
});

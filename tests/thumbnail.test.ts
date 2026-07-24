// Coverage for run-thumbnail backfill (src/thumbnail.ts), the deterministic paths that don't need
// a real browser: an existing thumb is reused as-is; a surviving input screenshot is HARVESTED
// into the run dir (so it outlives the next input/ sweep) and recorded on the manifest; a run with
// nothing left to show returns null so the gallery can fall back to its placeholder. The
// render-an-output path needs headless Chromium and is exercised live, not here.
import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store";
import { INPUT_DIR } from "../src/inputResolver";
import { ensureRunThumbnail } from "../src/thumbnail";

describe("ensureRunThumbnail", () => {
  const createdRuns: string[] = [];
  const createdInputs: string[] = [];

  afterAll(() => {
    for (const id of createdRuns) {
      try {
        fs.rmSync(store.runDir(id), { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
    for (const file of createdInputs) {
      try {
        fs.rmSync(file, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  });

  function mkRun(label: string, manifest: Partial<store.Manifest>): { id: string; dir: string } {
    const id = store.newRunId(label);
    store.writeManifest(id, { runId: id, status: "done", ...manifest } as store.Manifest);
    createdRuns.push(id);
    return { id, dir: store.runDir(id) };
  }

  it("reuses an existing thumb file without touching anything else", async () => {
    const { id, dir } = mkRun("thumb-existing", { thumb: "thumb.png", inputs: [], jobs: [] });
    fs.writeFileSync(path.join(dir, "thumb.png"), Buffer.from([1, 2, 3]));

    const result = await ensureRunThumbnail(id);

    expect(result?.mime).toBe("image/png");
    expect(result?.abs).toBe(path.join(dir, "thumb.png"));
  });

  it("harvests a surviving input screenshot into the run dir and records it", async () => {
    // A real input file the manifest points at, still on disk.
    const inputName = `thumbtest-${Date.now()}.png`;
    const inputAbs = path.join(INPUT_DIR, inputName);
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    fs.writeFileSync(inputAbs, Buffer.from([9, 8, 7]));
    createdInputs.push(inputAbs);

    const { id, dir } = mkRun("thumb-from-input", {
      thumb: null,
      inputs: [{ id: "i1", name: inputName, type: "image", preview: inputName }],
      jobs: [],
    } as unknown as Partial<store.Manifest>);

    const result = await ensureRunThumbnail(id);

    // Copied in as thumb.png (durable) and pointed at the copy, not the ephemeral input.
    expect(result?.abs).toBe(path.join(dir, "thumb.png"));
    expect(fs.existsSync(path.join(dir, "thumb.png"))).toBe(true);
    // And recorded on the manifest so summaries surface it.
    expect(store.readManifest(id)?.thumb).toBe("thumb.png");
  });

  it("returns null when there is no thumb, no surviving input, and no output", async () => {
    const { id } = mkRun("thumb-nothing", { thumb: null, inputs: [], jobs: [] });
    expect(await ensureRunThumbnail(id)).toBeNull();
  });

  it("returns null for an invalid run id instead of throwing", async () => {
    expect(await ensureRunThumbnail("../etc/passwd")).toBeNull();
  });
});

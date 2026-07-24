import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as inputResolver from "../src/inputResolver";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("inputResolver", () => {
  const tmpIn = fs.mkdtempSync(path.join(os.tmpdir(), "reimg-in-"));
  fs.writeFileSync(path.join(tmpIn, "Single Shot.png"), TINY_PNG);
  fs.mkdirSync(path.join(tmpIn, "1"));
  fs.writeFileSync(path.join(tmpIn, "1", "a.png"), TINY_PNG);
  fs.writeFileSync(path.join(tmpIn, "1", "b.jpg"), TINY_PNG);
  fs.writeFileSync(path.join(tmpIn, "notes.txt"), "ignore me");
  const items = inputResolver.listInputs(tmpIn);

  afterAll(() => {
    try { fs.rmSync(tmpIn, { recursive: true, force: true }); } catch (_) {}
  });

  it("discovers 2 input items (1 image + 1 group)", () => {
    expect(items.length).toBe(2);
  });

  it("group folder collects multiple images", () => {
    const group = items.find((i) => i.type === "group");
    expect(group?.imageCount).toBe(2);
  });

  it("loose image is a single subject", () => {
    const single = items.find((i) => i.type === "image");
    expect(single?.imageCount).toBe(1);
  });

  it("resolveSelection filters by id", () => {
    const group = items.find((i) => i.type === "group")!;
    const picked = inputResolver.resolveSelection(items, { ids: [group.id] });
    expect(picked.length).toBe(1);
  });

  it("loadImages returns base64 payloads", () => {
    const group = items.find((i) => i.type === "group")!;
    const imgs = inputResolver.loadImages(group, { inputDir: tmpIn });
    expect(imgs.length).toBe(2);
    expect(imgs[0]!.data.length).toBeGreaterThan(0);
    expect(imgs[0]!.mime.startsWith("image/")).toBe(true);
  });

  it("a missing input folder is safe and returns no items", () => {
    expect(inputResolver.listInputs(path.join(tmpIn, "does-not-exist"))).toEqual([]);
  });

  it("saveUploadedImages writes a pasted screenshot into input/, returns the new selected id, avoids overwriting, and rejects mismatched bytes", () => {
    const tmpUpload = fs.mkdtempSync(path.join(os.tmpdir(), "reimg-upload-"));
    try {
      const uploaded = inputResolver.saveUploadedImages(
        [{ name: "Clipboard Shot.png", mime: "image/png", data: `data:image/png;base64,${TINY_PNG.toString("base64")}` }],
        { inputDir: tmpUpload, now: new Date("2026-06-25T12:00:00Z") }
      );
      expect(uploaded.saved.length).toBe(1);
      expect(fs.existsSync(path.join(tmpUpload, uploaded.saved[0]!.rel))).toBe(true);
      expect(uploaded.addedIds.length).toBe(1);
      expect(uploaded.inputs.some((i) => i.id === uploaded.addedIds[0])).toBe(true);

      const uploadedAgain = inputResolver.saveUploadedImages(
        [{ name: "Clipboard Shot.png", mime: "image/png", data: TINY_PNG.toString("base64") }],
        { inputDir: tmpUpload }
      );
      expect(uploadedAgain.saved[0]!.rel).not.toBe(uploaded.saved[0]!.rel);

      let badUpload: unknown = null;
      try {
        inputResolver.saveUploadedImages(
          [{ name: "fake.png", mime: "image/png", data: Buffer.from("not really a png").toString("base64") }],
          { inputDir: tmpUpload }
        );
      } catch (e) {
        badUpload = e;
      }
      const badUploadStatus =
        badUpload instanceof Error && "status" in badUpload ? (badUpload as Error & { status?: number }).status : undefined;
      expect(badUploadStatus).toBe(400);
    } finally {
      try { fs.rmSync(tmpUpload, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe("references: discovery, resolution, loading", () => {
  const tmpRef = fs.mkdtempSync(path.join(os.tmpdir(), "reimg-ref-"));
  fs.writeFileSync(path.join(tmpRef, "palette.png"), TINY_PNG);
  fs.mkdirSync(path.join(tmpRef, "cards"));
  fs.writeFileSync(path.join(tmpRef, "cards", "c1.jpg"), TINY_PNG);
  fs.writeFileSync(path.join(tmpRef, "notes.txt"), "ignore");
  const refs = inputResolver.listReferences(tmpRef);

  afterAll(() => {
    try { fs.rmSync(tmpRef, { recursive: true, force: true }); } catch (_) {}
  });

  it("finds loose + nested images (skips non-images)", () => {
    expect(refs.length).toBe(2);
  });

  it('resolveReferences("all") returns every rel', () => {
    expect(inputResolver.resolveReferences("all", tmpRef).sort()).toEqual(["cards/c1.jpg", "palette.png"]);
  });

  it("resolveReferences by name", () => {
    expect(inputResolver.resolveReferences("palette.png", tmpRef)).toEqual(["palette.png"]);
  });

  it("resolveReferences accepts an array of rels", () => {
    expect(inputResolver.resolveReferences(["palette.png", "cards/c1.jpg"], tmpRef).sort()).toEqual([
      "cards/c1.jpg",
      "palette.png",
    ]);
  });

  it("resolveReferences accepts {images:[]}", () => {
    expect(inputResolver.resolveReferences({ images: ["cards/c1.jpg"] }, tmpRef)).toEqual(["cards/c1.jpg"]);
  });

  it("resolveReferences drops unknown entries", () => {
    expect(inputResolver.resolveReferences(["nope.png"], tmpRef)).toEqual([]);
  });

  it("resolveReferences(null) is empty", () => {
    expect(inputResolver.resolveReferences(null, tmpRef)).toEqual([]);
  });

  it("loadReferenceImages returns base64 payloads", () => {
    const refImgs = inputResolver.loadReferenceImages(["palette.png"], { refDir: tmpRef });
    expect(refImgs.length).toBe(1);
    expect(refImgs[0]!.data.length).toBeGreaterThan(0);
    expect(refImgs[0]!.mime.startsWith("image/")).toBe(true);
  });
});

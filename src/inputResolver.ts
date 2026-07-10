import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, isImageFile, imageToBase64, slugify, normalizeSelectionIds, type SelectionInput, type ImagePayload } from "./util";

const INPUT_DIR = path.join(ROOT, "input");
const REFERENCE_DIR = path.join(ROOT, "reference");
const DEFAULT_UPLOAD_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const UPLOAD_MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};
const UPLOAD_EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(UPLOAD_MIME_EXT).map(([mime, ext]) => [ext, mime]));

function listImagesIn(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listImagesIn(full)); // recurse within a group
    else if (e.isFile() && isImageFile(e.name)) out.push(full);
  }
  return out;
}

interface InputItem {
  id: string;
  name: string;
  type: "group" | "image";
  imageCount: number;
  images: string[];
  preview: string;
}

/**
 * Discover input items. Rules (per the spec):
 *   - A loose image file in input/ is a single-image subject.
 *   - A subfolder in input/ is ONE subject with multiple reference images.
 * Returns lightweight metadata (no base64) suitable for listing in the UI.
 */
function listInputs(inputDir: string = INPUT_DIR): InputItem[] {
  const items: InputItem[] = [];
  if (!fs.existsSync(inputDir)) return items;
  const entries = fs
    .readdirSync(inputDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // Ensure ids are unique even if two names slugify to the same token, so one
  // subject can never overwrite another's outputs.
  const seen = new Map<string, number>();
  const uniqueId = (base: string): string => {
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };

  for (const e of entries) {
    const full = path.join(inputDir, e.name);
    if (e.isDirectory()) {
      const images = listImagesIn(full);
      if (!images.length) continue;
      items.push({
        id: uniqueId(slugify(e.name)),
        name: e.name,
        type: "group",
        imageCount: images.length,
        images: images.map((p) => path.relative(inputDir, p).split(path.sep).join("/")),
        preview: path.relative(inputDir, images[0] as string).split(path.sep).join("/"),
      });
    } else if (e.isFile() && isImageFile(e.name)) {
      const rel = path.relative(inputDir, full).split(path.sep).join("/");
      items.push({
        id: uniqueId(slugify(path.parse(e.name).name)),
        name: e.name,
        type: "image",
        imageCount: 1,
        images: [rel],
        preview: rel,
      });
    }
  }
  return items;
}

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function uploadTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

interface UploadInput {
  mime?: string;
  name?: string;
  data?: string;
}

function normalizeUploadMime(upload: UploadInput): string {
  const direct = String(upload?.mime || "").toLowerCase().split(";")[0]?.trim() || "";
  if (UPLOAD_MIME_EXT[direct]) return direct;
  const ext = path.extname(String(upload?.name || "")).toLowerCase();
  return UPLOAD_EXT_MIME[ext] || "";
}

function imageMagicMatches(buf: Buffer, mime: string): boolean {
  if (mime === "image/png") return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === "image/jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/webp") {
    return (
      buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP"
    );
  }
  if (mime === "image/gif") {
    const head = buf.length >= 6 ? buf.toString("ascii", 0, 6) : "";
    return head === "GIF87a" || head === "GIF89a";
  }
  if (mime === "image/bmp") return buf.length >= 2 && buf.toString("ascii", 0, 2) === "BM";
  return false;
}

interface DecodedImage {
  buffer: Buffer;
  mime: string;
  ext: string;
}

function decodeUploadedImage(upload: UploadInput, { maxBytes = DEFAULT_UPLOAD_IMAGE_LIMIT_BYTES }: { maxBytes?: number } = {}): DecodedImage {
  if (!upload || typeof upload !== "object") throw statusError("Missing image upload.", 400);
  let data = typeof upload.data === "string" ? upload.data : "";
  const dataUrl = data.match(/^data:([^;,]+);base64,(.*)$/s);
  const inlineMime = dataUrl ? dataUrl[1] : "";
  if (dataUrl) data = dataUrl[2] as string;

  const mime = normalizeUploadMime({ ...upload, mime: upload.mime || inlineMime });
  if (!mime) throw statusError("Unsupported image type. Use PNG, JPG, WebP, GIF, or BMP.", 415);

  const compact = data.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw statusError("Invalid image data.", 400);

  const buffer = Buffer.from(compact, "base64");
  if (!buffer.length) throw statusError("Image upload was empty.", 400);
  if (buffer.length > maxBytes) throw statusError(`Image is too large. Max size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`, 413);
  if (!imageMagicMatches(buffer, mime)) throw statusError("Image data did not match its declared type.", 400);

  return { buffer, mime, ext: UPLOAD_MIME_EXT[mime] as string };
}

function uniqueInputPath(inputDir: string, base: string, ext: string): { rel: string; full: string } {
  let n = 1;
  let rel = `${base}${ext}`;
  while (fs.existsSync(path.join(inputDir, rel))) {
    n++;
    rel = `${base}-${n}${ext}`;
  }
  return { rel, full: path.join(inputDir, rel) };
}

interface SavedUpload {
  name: string;
  rel: string;
  mime: string;
  bytes: number;
}

interface SaveUploadedImagesResult {
  saved: SavedUpload[];
  addedIds: string[];
  inputs: InputItem[];
}

function saveUploadedImages(
  images: UploadInput[],
  { inputDir = INPUT_DIR, now = new Date(), maxBytes = DEFAULT_UPLOAD_IMAGE_LIMIT_BYTES }: { inputDir?: string; now?: Date; maxBytes?: number } = {}
): SaveUploadedImagesResult {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) throw statusError("No images were provided.", 400);
  if (list.length > 25) throw statusError("Upload up to 25 images at a time.", 400);

  ensureDir(inputDir);
  const saved: SavedUpload[] = [];
  list.forEach((upload, index) => {
    const parsed = decodeUploadedImage(upload, { maxBytes });
    const rawBase = path.parse(String(upload?.name || "")).name;
    const fallback = `screenshot-${uploadTimestamp(now)}${list.length > 1 ? `-${index + 1}` : ""}`;
    const base = slugify(rawBase || fallback);
    const target = uniqueInputPath(inputDir, base, parsed.ext);
    fs.writeFileSync(target.full, parsed.buffer);
    saved.push({ name: path.basename(target.full), rel: target.rel, mime: parsed.mime, bytes: parsed.buffer.length });
  });

  const inputs = listInputs(inputDir);
  const addedIds: string[] = [];
  for (const file of saved) {
    const item = inputs.find((it) => Array.isArray(it.images) && it.images.includes(file.rel));
    if (item && !addedIds.includes(item.id)) addedIds.push(item.id);
  }
  return { saved, addedIds, inputs };
}

// Delete one input by id: a loose file is removed; a group folder is removed
// whole. Guarded to never touch anything outside the input dir.
function deleteInput(id: string, { inputDir = INPUT_DIR }: { inputDir?: string } = {}): InputItem[] {
  const items = listInputs(inputDir);
  const item = items.find((it) => it.id === id);
  if (!item) throw statusError("Input not found.", 404);
  const base = path.resolve(inputDir);
  const rel = item.type === "group" ? item.name : (item.images[0] as string).split("/").join(path.sep);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw statusError("Refused to delete outside the input directory.", 403);
  }
  fs.rmSync(resolved, { recursive: item.type === "group", force: true });
  return listInputs(inputDir);
}

// Resolve a selection ('all' | id | id[] | {ids:[]}) against the item list.
function resolveSelection(items: InputItem[], selection: SelectionInput): InputItem[] {
  const ids = normalizeSelectionIds(selection);
  if (!selection || (ids.length === 1 && ids[0] === "all")) return items.slice();
  const set = new Set(ids);
  return items.filter((it) => set.has(it.id) || set.has(it.name));
}

// Map a list of dir-relative image paths to base64 payloads.
interface LoadedImage extends ImagePayload {
  file: string;
}

function loadImagesFromDir(rels: string[], dir: string): LoadedImage[] {
  return rels.map((rel) => {
    const full = path.join(dir, rel.split("/").join(path.sep));
    const { mime, data, bytes } = imageToBase64(full);
    return { mime, data, bytes, file: rel };
  });
}

// Load the actual image bytes (base64) for an item, capped to maxImages.
function loadImages(item: InputItem, { maxImages = 8, inputDir = INPUT_DIR }: { maxImages?: number; inputDir?: string } = {}): LoadedImage[] {
  const cap = Number.isFinite(maxImages) && maxImages > 0 ? Math.floor(maxImages) : 8;
  const rels = item.images.slice(0, Math.max(1, cap));
  return loadImagesFromDir(rels, inputDir);
}

// ---------------------------------------------------------------- references
// Style/direction reference images live in reference/. They are NOT subjects to
// reimagine, they're fed alongside an input as aesthetic direction. A loose
// image is one reference; images inside subfolders are flattened in too.
interface ReferenceItem {
  id: string;
  name: string;
  rel: string;
  preview: string;
}

function listReferences(refDir: string = REFERENCE_DIR): ReferenceItem[] {
  const out: ReferenceItem[] = [];
  if (!fs.existsSync(refDir)) return out;
  for (const full of listImagesIn(refDir)) {
    const rel = path.relative(refDir, full).split(path.sep).join("/");
    out.push({ id: rel, name: rel, rel, preview: rel });
  }
  return out;
}

// Resolve a reference selection ('all' | rel/name | rel[] | {ids|rels:[]}) to
// dir-relative paths that actually exist under reference/.
function resolveReferences(selection: SelectionInput, refDir: string = REFERENCE_DIR): string[] {
  const all = listReferences(refDir);
  if (!selection) return [];
  const ids = normalizeSelectionIds(selection, { extraKeys: ["rels", "images", "ids"] });
  if (ids.length === 1 && ids[0] === "all") return all.map((r) => r.rel);
  const valid = new Set(all.map((r) => r.rel));
  const byName = new Map(all.map((r) => [r.name, r.rel]));
  const out: string[] = [];
  for (const id of ids) {
    if (valid.has(id)) out.push(id);
    else if (byName.has(id)) out.push(byName.get(id) as string);
  }
  return out;
}

// Load reference image bytes (base64) for a set of dir-relative paths.
function loadReferenceImages(rels: string[], { maxImages = 8, refDir = REFERENCE_DIR }: { maxImages?: number; refDir?: string } = {}): LoadedImage[] {
  const cap = Number.isFinite(maxImages) && maxImages > 0 ? Math.floor(maxImages) : 8;
  return loadImagesFromDir((rels || []).slice(0, Math.max(1, cap)), refDir);
}

export {
  INPUT_DIR,
  REFERENCE_DIR,
  listInputs,
  saveUploadedImages,
  deleteInput,
  resolveSelection,
  loadImages,
  loadImagesFromDir,
  listReferences,
  resolveReferences,
  loadReferenceImages,
};
export type { InputItem, ReferenceItem, LoadedImage, UploadInput, SavedUpload, SaveUploadedImagesResult, DecodedImage };

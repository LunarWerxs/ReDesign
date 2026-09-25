/**
 * Real logos and images cropped out of the input screenshot, so every redesign can embed the
 * product's actual brand marks and photos instead of a placeholder, an invented logo or a stock
 * image. Without this, outputs looked less like the real product than they should.
 *
 * The flow (idea from abi/screenshot-to-code's asset extraction, MIT; written fresh here): the
 * run's vision helper returns one box per wanted asset as box_2d [ymin, xmin, ymax, xmax]
 * normalized to 0-1000, or null when it cannot tell where the edges are. Boxes round OUTWARD
 * to whole pixels so no edge pixel of a logo is lost, and are cropped on the same pixel grid the
 * detector saw.
 *
 * Nothing here decodes arbitrary formats: the app ships no image library. A non-interlaced
 * 8/16-bit PNG (what screenshots almost always are) is cropped to a real PNG with node:zlib.
 * Anything else becomes an SVG that frames the original image through a viewBox, which is
 * lossless and needs no decoder. A JPEG whose EXIF orientation rotates it is skipped, because
 * without a decoder its crop cannot be put on the grid the detector saw.
 */
import fs from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { LoadedImage } from "../inputResolver";
import { ensureDir } from "../util";

interface DetectedAsset {
  id: string;
  label: string;
  kind: string;
  /** 1-based index into the input's images. */
  image: number;
  /** [ymin, xmin, ymax, xmax], 0-1000. */
  box: [number, number, number, number];
}

interface CroppedAsset {
  id: string;
  label: string;
  kind: string;
  /** Run-dir-relative, forward slashes. */
  rel: string;
  width: number;
  height: number;
}

interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MAX_ASSETS = 12;
// Below this a crop is a speck no model can use; above the area share it is the screen itself.
const MIN_SIDE_PX = 8;
const MAX_AREA_SHARE = 0.9;
const ASSET_KINDS = new Set(["logo", "photo", "avatar", "illustration"]);

const ASSET_DETECT_PROMPT =
  "Find the real brand and content imagery in the attached UI screenshot(s) that a redesign should reuse rather than redraw: " +
  "the product or company logo, partner or customer logos, product photos, avatars, illustrations and hero images. " +
  "Skip plain text, generic UI icons (menu, search, arrows, checkboxes), buttons and whole sections. " +
  'For each one give: "id" (a short kebab-case name such as "brand-logo" or "hero-photo"), "label" (what it shows, under 12 words), ' +
  '"kind" (logo, photo, avatar or illustration), "image" (the 1-based index of the screenshot it is in) and "box_2d" as ' +
  "[ymin, xmin, ymax, xmax] normalized to 0-1000 over that screenshot, drawn tightly around the asset. " +
  'When you cannot tell exactly where an asset\'s edges are, set its box_2d to null instead of guessing. ' +
  `Return at most ${MAX_ASSETS}, most important first. Output only JSON of the form {"assets": [...]}, no preamble.`;

/** Opt-out: ASSET_CROPS=0 in the environment skips the detection call and its cost. */
function assetCropsEnabled(): boolean {
  return String(process.env.ASSET_CROPS ?? "").trim() !== "0";
}

function firstJson(text: string): unknown {
  const body = String(text || "").replace(/```(?:json)?/gi, "");
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* try the other shape */
    }
  }
  return null;
}

function slug(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The detector's reply as validated assets. A null or malformed box drops that asset, never the rest. */
function parseDetectedAssets(text: string, imageCount: number): DetectedAsset[] {
  const parsed = firstJson(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { assets?: unknown })?.assets) ? (parsed as { assets: unknown[] }).assets : [];
  const seen = new Set<string>();
  const out: DetectedAsset[] = [];
  for (const [i, raw] of list.entries()) {
    if (out.length >= MAX_ASSETS) break;
    const entry = (raw || {}) as Record<string, unknown>;
    const box = entry.box_2d;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const image = entry.image == null ? 1 : Number(entry.image);
    if (!Number.isInteger(image) || image < 1 || image > imageCount) continue;
    const base = slug(entry.id) || slug(entry.label) || `asset-${i + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    const kind = String(entry.kind || "").toLowerCase();
    out.push({
      id,
      label: String(entry.label || id).replace(/\s+/g, " ").trim().slice(0, 120),
      kind: ASSET_KINDS.has(kind) ? kind : "image",
      image,
      box: box as [number, number, number, number],
    });
  }
  return out;
}

/** A 0-1000 box to whole pixels, rounded outward and clamped; null when too small or the whole screen. */
function normalizeBox(box: readonly number[], width: number, height: number): PixelRect | null {
  const [y0, x0, y1, x1] = box.map((v) => Math.min(1000, Math.max(0, v))) as [number, number, number, number];
  const rect = {
    left: Math.floor((Math.min(x0, x1) / 1000) * width),
    top: Math.floor((Math.min(y0, y1) / 1000) * height),
    right: Math.min(width, Math.ceil((Math.max(x0, x1) / 1000) * width)),
    bottom: Math.min(height, Math.ceil((Math.max(y0, y1) / 1000) * height)),
  };
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  if (w < MIN_SIDE_PX || h < MIN_SIDE_PX || w * h > MAX_AREA_SHARE * width * height) return null;
  return rect;
}

// --- Image headers ------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function exifOrientation(seg: Buffer): number | null {
  if (seg.length < 14 || seg.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const tiff = seg.subarray(6);
  const le = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const ifd = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 10 > tiff.length) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

function jpegInfo(buf: Buffer): { width: number; height: number; orientation: number } | null {
  let off = 2;
  let orientation = 1;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1] as number;
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      off += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1) orientation = exifOrientation(buf.subarray(off + 4, off + 2 + len)) ?? orientation;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && off + 9 <= buf.length) return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), orientation };
    off += 2 + len;
  }
  return null;
}

/** Pixel size (and EXIF orientation, 1 = upright) read from the header alone. */
function imageInfo(buf: Buffer): { width: number; height: number; orientation: number } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
  if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), orientation: 1 };
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const fourcc = buf.toString("latin1", 12, 16);
    if (fourcc === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), orientation: 1 };
    if (fourcc === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, orientation: 1 };
    if (fourcc === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, orientation: 1 };
    }
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegInfo(buf);
  return null;
}

// --- PNG crop -------------------------------------------------------------------------

interface PngImage {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** Bytes per pixel. */
  bpp: number;
  /** Chunks copied verbatim (palette, transparency, colour profile), in their original order. */
  ancillary: Buffer[];
  /** Unfiltered rows, width * bpp bytes each. */
  pixels: Buffer;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_KEPT_CHUNKS = new Set(["PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8/16-bit PNG to unfiltered rows; null for anything else. */
function decodePng(buf: Buffer): PngImage | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  const ancillary: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) return null;
    if (type === "IHDR") ihdr = buf.subarray(off + 8, off + 8 + len);
    else if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (PNG_KEPT_CHUNKS.has(type)) ancillary.push(buf.subarray(off, end));
    else if (type === "IEND") break;
    off = end;
  }
  if (!ihdr || ihdr.length < 13 || !idat.length) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8] as number;
  const colorType = ihdr[9] as number;
  const channels = PNG_CHANNELS[colorType];
  // Sub-byte depths would need bit shifting to cut at an arbitrary x, and Adam7 interlacing
  // stores pixels out of row order; both are rare in screenshots and take the SVG path.
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || ihdr[12] !== 0 || !width || !height) return null;
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] as number;
      const a = i >= bpp ? (pixels[dst + i - bpp] as number) : 0;
      const b = y ? (pixels[dst - stride + i] as number) : 0;
      const c = y && i >= bpp ? (pixels[dst - stride + i - bpp] as number) : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) v = x + paeth(a, b, c);
      else return null;
      pixels[dst + i] = v & 0xff;
    }
  }
  return { width, height, bitDepth, colorType, bpp, ancillary, pixels };
}

function encodePng(img: PngImage): Buffer {
  const stride = img.width * img.bpp;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = img.bitDepth;
  ihdr[9] = img.colorType;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), ...img.ancillary, pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A pixel-exact PNG crop, or null when the PNG is a kind decodePng does not handle. */
function cropPng(buf: Buffer, rect: PixelRect): Buffer | null {
  const img = decodePng(buf);
  if (!img || rect.right > img.width || rect.bottom > img.height) return null;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const rowBytes = width * img.bpp;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const from = (rect.top + y) * img.width * img.bpp + rect.left * img.bpp;
    img.pixels.copy(pixels, y * rowBytes, from, from + rowBytes);
  }
  return encodePng({ ...img, width, height, pixels });
}

/** The format-agnostic fallback: the original image framed through a viewBox. */
function svgCrop(buf: Buffer, mime: string, rect: PixelRect, width: number, height: number): string {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${rect.left} ${rect.top} ${w} ${h}"><image width="${width}" height="${height}" href="data:${mime};base64,${buf.toString("base64")}"/></svg>`;
}

/** Crop every detected asset out of its image and write it under <runDir>/assets/crops/<input>/. */
function saveAssetCrops(runDir: string, inputId: string, images: LoadedImage[], detected: DetectedAsset[]): CroppedAsset[] {
  const dirRel = path.posix.join("assets", "crops", String(inputId).replace(/[^\w.-]+/g, "_"));
  const out: CroppedAsset[] = [];
  for (const asset of detected) {
    const img = images[asset.image - 1];
    if (!img) continue;
    const buf = Buffer.from(img.data, "base64");
    const info = imageInfo(buf);
    if (!info || info.orientation !== 1) continue;
    const rect = normalizeBox(asset.box, info.width, info.height);
    if (!rect) continue;
    const png = img.mime === "image/png" ? cropPng(buf, rect) : null;
    const rel = path.posix.join(dirRel, `${asset.id}${png ? ".png" : ".svg"}`);
    ensureDir(path.join(runDir, ...dirRel.split("/")));
    fs.writeFileSync(path.join(runDir, ...rel.split("/")), png ?? svgCrop(buf, img.mime, rect, info.width, info.height));
    out.push({ id: asset.id, label: asset.label, kind: asset.kind, rel, width: rect.right - rect.left, height: rect.bottom - rect.top });
  }
  return out;
}

/**
 * Appended to every job's prompt, vision and text-only alike. URLs are relative to the output's
 * own folder (<runDir>/<inputId>/), so they resolve both in the viewer and in a downloaded zip.
 */
function assetCropBlock(assets: CroppedAsset[], outputDir: string): string {
  const lines = assets.map((a) => `- ${path.posix.relative(outputDir.split(path.sep).join("/"), a.rel)} (${a.kind}, ${a.width}x${a.height}px): ${a.label}`);
  return (
    "\n\n--- REAL ASSETS CROPPED FROM THE ORIGINAL ---\n" +
    "These images were cut out of the original screenshot. Wherever your redesign shows the same logo, photo, " +
    "avatar or illustration, embed the real one with an <img> tag using exactly the relative URL listed, instead of " +
    "drawing a placeholder, inventing a logo or using a stock image. Do not scale one far past its listed size, " +
    "where it would blur, and do not embed the whole screenshot:\n" +
    lines.join("\n")
  );
}

export {
  ASSET_DETECT_PROMPT,
  assetCropsEnabled,
  parseDetectedAssets,
  normalizeBox,
  imageInfo,
  decodePng,
  cropPng,
  saveAssetCrops,
  assetCropBlock,
};
export type { DetectedAsset, CroppedAsset, PixelRect };

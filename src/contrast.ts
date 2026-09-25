/**
 * WCAG text contrast, judged from rendered pixels rather than computed CSS colours.
 *
 * WHY pixels: a model-generated redesign often sets text over a photo, a gradient or a
 * translucent layer. A check that reads `color` and `background-color` sees none of that and
 * passes white-on-light-photo text. This reads the captured screenshot instead, so it judges
 * what a visitor actually sees.
 *
 * The method follows the idea behind Flutter's text contrast guideline
 * (flutter/flutter packages/flutter_test/lib/src/accessibility.dart, BSD-3-Clause), written
 * fresh here: for each text box, take the screenshot pixels inside the box inflated by a few
 * pixels, build a colour histogram, split the colours at the mean HSL lightness, and rate the
 * most frequent light colour against the most frequent dark one.
 *
 * Pure: no browser, no filesystem. The renderer (src/thumbnail.ts renderHtmlToPng) supplies the
 * PNG and the text boxes; GET /api/output/contrast glues the two together.
 */
import { inflateSync } from "node:zlib";

/** A decoded image, always 8-bit RGBA, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One painted line of text, in CSS pixels of the captured viewport. */
export interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePx: number;
  fontWeight: number;
}

export type ContrastLevel = "AA" | "AAA";

export interface ContrastFinding {
  text: string;
  ratio: number;
  required: number;
  large: boolean;
  light: string;
  dark: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface ContrastReport {
  level: ContrastLevel;
  /** Text boxes that had two or more colours to compare. */
  checked: number;
  /** Text boxes with a single flat colour (nothing painted to measure). */
  skipped: number;
  /** Failing boxes, worst first, capped at MAX_FINDINGS. */
  failing: ContrastFinding[];
  failingCount: number;
  worstRatio: number | null;
  passes: boolean;
}

/** Pixels added around each text box so the histogram sees the background as well as the glyphs. */
const INFLATE_PX = 4;
/** Ratios within this of the threshold still pass: anti-aliasing shifts the measured colours slightly. */
const TOLERANCE = 0.01;
const MAX_FINDINGS = 20;

// WCAG 2.x thresholds: [normal text, large text].
const THRESHOLDS: Record<ContrastLevel, [number, number]> = { AA: [4.5, 3.0], AAA: [7.0, 4.5] };

/** WCAG "large text": at least 18pt (24 CSS px), or 14pt (about 18.66 CSS px) when bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontWeight >= 700 && fontSizePx >= 18.66);
}

export function requiredRatio(level: ContrastLevel, large: boolean): number {
  const [normal, big] = THRESHOLDS[level];
  return large ? big : normal;
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a packed 0xRRGGBB colour. */
export function relativeLuminance(rgb: number): number {
  return 0.2126 * channelLuminance((rgb >> 16) & 0xff) + 0.7152 * channelLuminance((rgb >> 8) & 0xff) + 0.0722 * channelLuminance(rgb & 0xff);
}

/** WCAG contrast ratio between two packed colours, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** HSL lightness (0 to 1) of a packed colour. */
function hslLightness(rgb: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/**
 * The dominant light and dark colours inside `box` (inflated by INFLATE_PX, clipped to the
 * image), or null when the region holds a single colour or no pixels at all.
 */
export function dominantColours(img: RgbaImage, box: { x: number; y: number; width: number; height: number }): { light: number; dark: number } | null {
  const x0 = Math.max(0, Math.floor(box.x - INFLATE_PX));
  const y0 = Math.max(0, Math.floor(box.y - INFLATE_PX));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.width + INFLATE_PX));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.height + INFLATE_PX));
  if (x1 <= x0 || y1 <= y0) return null;

  const histogram = new Map<number, number>();
  let lightnessSum = 0;
  let pixels = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * img.width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      const rgb = ((img.data[i] as number) << 16) | ((img.data[i + 1] as number) << 8) | (img.data[i + 2] as number);
      histogram.set(rgb, (histogram.get(rgb) || 0) + 1);
      lightnessSum += hslLightness(rgb);
      pixels++;
    }
  }
  if (histogram.size < 2) return null;

  const meanLightness = lightnessSum / pixels;
  let light = -1;
  let lightCount = 0;
  let dark = -1;
  let darkCount = 0;
  for (const [rgb, count] of histogram) {
    if (hslLightness(rgb) > meanLightness) {
      if (count > lightCount) { light = rgb; lightCount = count; }
    } else if (count > darkCount) {
      dark = rgb;
      darkCount = count;
    }
  }
  if (light < 0 || dark < 0) return null;
  return { light, dark };
}

/** Score every text box against the WCAG threshold for `level`. */
export function scoreTextContrast(img: RgbaImage, boxes: TextBox[], level: ContrastLevel = "AA"): ContrastReport {
  const failing: ContrastFinding[] = [];
  let checked = 0;
  let skipped = 0;
  let worstRatio: number | null = null;
  for (const box of boxes) {
    const colours = dominantColours(img, box);
    if (!colours) {
      skipped++;
      continue;
    }
    checked++;
    const ratio = contrastRatio(colours.light, colours.dark);
    if (worstRatio === null || ratio < worstRatio) worstRatio = ratio;
    const large = isLargeText(box.fontSizePx, box.fontWeight);
    const required = requiredRatio(level, large);
    if (ratio >= required - TOLERANCE) continue;
    failing.push({
      text: box.text,
      ratio: Math.round(ratio * 100) / 100,
      required,
      large,
      light: hex(colours.light),
      dark: hex(colours.dark),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    });
  }
  failing.sort((a, b) => a.ratio - b.ratio);
  return {
    level,
    checked,
    skipped,
    failing: failing.slice(0, MAX_FINDINGS),
    failingCount: failing.length,
    worstRatio: worstRatio === null ? null : Math.round(worstRatio * 100) / 100,
    passes: failing.length === 0,
  };
}

// ── PNG decoding ─────────────────────────────────────────────────────────────────────────────
// WHY a hand-rolled decoder: the app has one runtime dependency and the only PNGs it needs to
// read are Chromium's own screenshots (8-bit RGB/RGBA, not interlaced), which node:zlib plus
// the five scanline filters fully covers.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG. Throws on anything else. */
export function decodePng(buf: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const data = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const bitDepth = data[8];
      colourType = data[9] ?? -1;
      const interlace = data[12];
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
        throw new Error("Unsupported PNG format (need 8-bit RGB/RGBA, not interlaced)");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || colourType < 0) throw new Error("PNG has no image header");

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colourType === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const v = raw[p + i] as number;
      const a = i >= bpp ? (cur[i - bpp] as number) : 0;
      const b = prev[i] as number;
      const c = i >= bpp ? (prev[i - bpp] as number) : 0;
      switch (filter) {
        case 0: cur[i] = v; break;
        case 1: cur[i] = (v + a) & 0xff; break;
        case 2: cur[i] = (v + b) & 0xff; break;
        case 3: cur[i] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`Bad PNG filter type ${filter}`);
      }
    }
    p += stride;
    const rowOut = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = rowOut + x * 4;
      out[d] = cur[s] as number;
      out[d + 1] = cur[s + 1] as number;
      out[d + 2] = cur[s + 2] as number;
      out[d + 3] = bpp === 4 ? (cur[s + 3] as number) : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

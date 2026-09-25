/**
 * Pins the pixel-histogram WCAG contrast check (src/contrast.ts): it rates what was painted,
 * not what CSS claims, applies the AA large-text rule, skips flat regions, and reads the
 * Chromium screenshot PNGs it is fed. Pure: no browser.
 */
import { describe, it, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { contrastRatio, decodePng, scoreTextContrast, type RgbaImage, type TextBox } from "../src/contrast";

function image(width: number, height: number, rgb: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (rgb >> 16) & 0xff;
    data[i + 1] = (rgb >> 8) & 0xff;
    data[i + 2] = rgb & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function fill(img: RgbaImage, x: number, y: number, w: number, h: number, rgb: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = (rgb >> 16) & 0xff;
      img.data[i + 1] = (rgb >> 8) & 0xff;
      img.data[i + 2] = rgb & 0xff;
    }
  }
}

// A 40x12 "line of text": a glyph stripe of `ink` through the middle of the box.
function textOn(bg: number, ink: number, fontSizePx = 16, fontWeight = 400): { img: RgbaImage; box: TextBox } {
  const img = image(80, 40, bg);
  fill(img, 22, 16, 36, 4, ink);
  return { img, box: { text: "Sample", x: 20, y: 12, width: 40, height: 12, fontSizePx, fontWeight } };
}

describe("contrast: pixel-histogram WCAG check", () => {
  it("contrastRatio matches the WCAG reference values", () => {
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 5);
    expect(contrastRatio(0x767676, 0xffffff)).toBeCloseTo(4.54, 2);
  });

  it("passes #767676 on white and fails #999999 on white at AA", () => {
    const ok = textOn(0xffffff, 0x767676);
    expect(scoreTextContrast(ok.img, [ok.box]).passes).toBe(true);
    const bad = textOn(0xffffff, 0x999999);
    const report = scoreTextContrast(bad.img, [bad.box]);
    expect(report.passes).toBe(false);
    expect(report.failing[0]).toMatchObject({ text: "Sample", required: 4.5, light: "#ffffff", dark: "#999999" });
  });

  it("rates text by the pixels behind it, so dark text on a dark image area fails", () => {
    // The page background is white (what a CSS-colour check would compare against), but the
    // text sits on a dark image block that covers the whole inflated box.
    const img = image(80, 40, 0xffffff);
    fill(img, 10, 4, 60, 30, 0x303030);
    fill(img, 22, 16, 36, 4, 0x101010);
    const report = scoreTextContrast(img, [{ text: "Hero", x: 20, y: 12, width: 40, height: 12, fontSizePx: 16, fontWeight: 400 }]);
    expect(report.passes).toBe(false);
    expect(report.worstRatio).toBeLessThan(2);
  });

  it("applies the lower large-text threshold to 24px text and to bold 18.66px text", () => {
    // #949494 on white is about 3.03:1: fails normal text, passes large text.
    const normal = textOn(0xffffff, 0x949494, 16, 400);
    expect(scoreTextContrast(normal.img, [normal.box]).passes).toBe(false);
    const big = textOn(0xffffff, 0x949494, 24, 400);
    expect(scoreTextContrast(big.img, [big.box]).passes).toBe(true);
    const bold = textOn(0xffffff, 0x949494, 19, 700);
    expect(scoreTextContrast(bold.img, [bold.box]).passes).toBe(true);
    expect(scoreTextContrast(big.img, [big.box], "AAA").passes).toBe(false);
  });

  it("skips a box with a single flat colour instead of failing it", () => {
    const img = image(80, 40, 0xffffff);
    const report = scoreTextContrast(img, [{ text: "clipped", x: 20, y: 12, width: 40, height: 12, fontSizePx: 16, fontWeight: 400 }]);
    expect(report).toMatchObject({ checked: 0, skipped: 1, passes: true, worstRatio: null });
  });
});

describe("contrast: decodePng", () => {
  function chunk(type: string, data: Uint8Array): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, Buffer.from(data), Buffer.alloc(4)]); // CRC is not verified
  }

  it("decodes an 8-bit RGB PNG whose rows use the None, Sub and Up filters", () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0); // width
    ihdr.writeUInt32BE(3, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    // Row 0 None: (10,20,30) (40,50,60). Row 1 Sub: same pixels. Row 2 Up: row 1 plus 1.
    const raw = Uint8Array.from([
      0, 10, 20, 30, 40, 50, 60,
      1, 10, 20, 30, 30, 30, 30,
      2, 1, 1, 1, 1, 1, 1,
    ]);
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array(0)),
    ]);
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([2, 3]);
    expect(Array.from(img.data.subarray(0, 8))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(img.data.subarray(8, 16))).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(img.data.subarray(16, 24))).toEqual([11, 21, 31, 255, 41, 51, 61, 255]);
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow("Not a PNG");
  });
});

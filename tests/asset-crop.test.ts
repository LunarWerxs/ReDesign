// Pins the pixel contract of the real-asset crops (src/runner/asset-crop.ts): a detector box
// rounds OUTWARD so no edge pixel of a logo is lost, a PNG crop carries exactly the source
// pixels whatever row filters the source used, and one bad box in the detector's reply drops
// that asset alone.
import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { cropPng, decodePng, normalizeBox, parseDetectedAssets } from "../src/runner/asset-crop";

const W = 4;
const H = 3;
const pixel = (x: number, y: number) => [x * 10 + y, x * 20 + 1, y * 30 + 2];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

// An 8-bit RGB PNG whose rows use the Sub, Up and Paeth filters, so decoding has to undo each.
function filteredPng(): Buffer {
  const rows = Array.from({ length: H }, (_, y) => Buffer.from(Array.from({ length: W }, (_, x) => pixel(x, y)).flat()));
  const filters = [1, 2, 4];
  const raw = rows.map((row, y) => {
    const prev = y ? (rows[y - 1] as Buffer) : Buffer.alloc(row.length);
    const out = Buffer.alloc(row.length + 1);
    out[0] = filters[y] as number;
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? (row[i - 3] as number) : 0;
      const b = prev[i] as number;
      const c = i >= 3 ? (prev[i - 3] as number) : 0;
      const predictor = out[0] === 1 ? a : out[0] === 2 ? b : paeth(a, b, c);
      out[i + 1] = ((row[i] as number) - predictor) & 0xff;
    }
    return out;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(raw))), chunk("IEND", Buffer.alloc(0))]);
}

describe("asset crops", () => {
  it("rounds a detector box outward to whole pixels", () => {
    // x 125..875 of 1000 over 20px is 2.5..17.5: the half pixels on both edges are kept.
    expect(normalizeBox([0, 125, 1000, 875], 20, 20)).toEqual({ left: 2, top: 0, right: 18, bottom: 20 });
  });

  it("crops a filtered PNG to exactly the source pixels", () => {
    const cropped = cropPng(filteredPng(), { left: 1, top: 1, right: 3, bottom: 3 });
    const img = decodePng(cropped as Buffer);
    expect(img?.width).toBe(2);
    expect(img?.height).toBe(2);
    expect([...(img?.pixels ?? [])]).toEqual([...pixel(1, 1), ...pixel(2, 1), ...pixel(1, 2), ...pixel(2, 2)]);
  });

  it("drops an ambiguous (null) box without losing the other assets", () => {
    const reply = '```json\n{"assets":[{"id":"Brand Logo","kind":"logo","box_2d":[0,0,100,300]},{"id":"hero","box_2d":null},{"id":"brand-logo","box_2d":[500,0,900,500]}]}\n```';
    expect(parseDetectedAssets(reply, 1).map((a) => [a.id, a.kind])).toEqual([
      ["brand-logo", "logo"],
      ["brand-logo-2", "image"],
    ]);
  });
});

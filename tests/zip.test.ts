import { expect, test } from "bun:test";
import { buildZipStream, type ZipStreamEntry } from "../src/zip";

test("zip stream writes chunked source entries with a data descriptor", async () => {
  const source: ZipStreamEntry = {
    name: "chunked.txt",
    async *open() {
      yield new TextEncoder().encode("hello ");
      yield new TextEncoder().encode("world");
    },
  };
  const bytes = new Uint8Array(await new Response(buildZipStream([source])).arrayBuffer());
  const local = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(local.getUint16(6, true) & 0x0008).toBe(0x0008);
  expect(local.getUint16(8, true)).toBe(0);
  const descriptorOffset = 30 + new TextEncoder().encode(source.name).length + 11;
  expect(local.getUint32(descriptorOffset, true)).toBe(0x08074b50);
  expect(local.getUint32(descriptorOffset + 8, true)).toBe(11);
  expect(local.getUint32(descriptorOffset + 12, true)).toBe(11);
});

test("zip stream rejects a known oversize source before opening it", async () => {
  let opened = 0;
  const source: ZipStreamEntry = {
    name: "large.bin",
    size: 32,
    async *open() { opened++; yield new Uint8Array(32); },
  };
  await expect(new Response(buildZipStream([source], { maxInputBytes: 16 })).arrayBuffer()).rejects.toThrow("export exceeds 16 byte limit");
  expect(opened).toBe(0);
});

test("zip stream stops a source that grows past its preflight size", async () => {
  let chunks = 0;
  const source: ZipStreamEntry = {
    name: "growing.bin",
    size: 4,
    async *open() { chunks++; yield new Uint8Array(8); chunks++; yield new Uint8Array(8); chunks++; yield new Uint8Array(8); },
  };
  await expect(new Response(buildZipStream([source], { maxInputBytes: 12 })).arrayBuffer()).rejects.toThrow("export exceeds 12 byte limit");
  expect(chunks).toBe(2);
});

test("cancelling a zip stream closes the active source", async () => {
  let closed = false;
  const source: ZipStreamEntry = {
    name: "slow.bin",
    async *open() {
      try { yield new Uint8Array([1]); await new Promise(() => {}); }
      finally { closed = true; }
    },
  };
  const reader = buildZipStream([source]).getReader();
  await reader.read(); // local header
  await reader.read(); // filename
  await reader.read(); // first source chunk
  await reader.cancel();
  expect(closed).toBe(true);
});

test("zip stream stops reading entries after its abort signal", async () => {
  const controller = new AbortController();
  let reads = 0;
  async function* entries() {
    for (let i = 0; i < 100; i++) {
      reads++;
      if (i === 1) controller.abort();
      yield { name: `${i}.txt`, data: new TextEncoder().encode("x") };
    }
  }
  const stream = buildZipStream(entries(), { signal: controller.signal });
  await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  expect(reads).toBeLessThan(4);
});

test("zip stream rejects entries over its practical byte ceiling", async () => {
  async function* entries() {
    yield { name: "large.bin", data: new Uint8Array(32) };
  }
  const stream = buildZipStream(entries(), { maxInputBytes: 16 });
  await expect(new Response(stream).arrayBuffer()).rejects.toThrow("export exceeds 16 byte limit");
});

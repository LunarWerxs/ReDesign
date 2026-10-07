/**
 * Minimal ZIP writer, enough to hand a whole run's outputs back as one download.
 *
 * Deliberately dependency-free: the app ships with exactly one runtime dependency and adding an
 * archiver for a single endpoint is not worth it. This writes the classic PKZIP layout (local file
 * header per entry, then a central directory, then an end-of-central-directory record) with DEFLATE
 * via node:zlib, which is the same method every unzip tool has supported for thirty years.
 *
 * Scope, so nobody mistakes this for a general-purpose archiver:
 *   - no ZIP64, so it is capped at 4 GB total and 65,535 entries (a run is a few MB and a few dozen
 *     files; buildZip throws rather than silently producing a corrupt archive if that is exceeded)
 *   - no directory entries, no permissions, no comments, no encryption
 *   - names are stored UTF-8 with the language-encoding flag set
 *   - HTTP exports stream file contents; buildZip remains a buffered compatibility helper
 */

import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";

// Async, not deflateRawSync: this runs inside a request handler on Bun's single JS thread, and a
// run can hold a hundred outputs. Compressing them synchronously in a loop stalls every SSE
// heartbeat and progress broadcast for the whole archive; awaiting the async form yields between
// files so a download can no longer freeze a run that is still going.
const deflate = promisify(deflateRaw);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only timestamp the base ZIP format carries. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive, forward slashes. */
  name: string;
  data: Uint8Array;
  modified?: Date;
}

/** A ZIP entry whose contents are produced on demand instead of retained in memory. */
export interface ZipStreamEntry {
  /** Path inside the archive, forward slashes. */
  name: string;
  /** Size observed during preflight. It is checked again while reading in case the file grows. */
  size?: number;
  modified?: Date;
  /** Open a fresh source when the archive reaches this entry. */
  open(signal: AbortSignal): AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export type ZipInputEntry = ZipEntry | ZipStreamEntry;

export interface ZipStreamOptions {
  /** A practical export ceiling, independent of ZIP's 4 GB format ceiling. */
  maxInputBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

/**
 * Write a ZIP incrementally. File entries use STORE records and data descriptors; only the
 * small central directory is retained until the final trailer. This keeps a run download from
 * retaining the source files, compressed files, and final archive at the same time.
 */
export function buildZipStream(entries: AsyncIterable<ZipInputEntry> | Iterable<ZipInputEntry>, opts: ZipStreamOptions = {}): ReadableStream<Uint8Array> {
  const maxInputBytes = opts.maxInputBytes ?? 512 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES - 1;
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const state: ZipWriteState = { encoder, signal: cancellation.signal, maxInputBytes, centrals: [], offset: 0, declaredInput: 0, observedInput: 0 };
  const iterator = (async function* () {
    let count = 0;
    for await (const entry of entries) {
      if (state.signal.aborted) throw new Error("export cancelled");
      if (++count > maxEntries) throw new Error(`too many files for export (${count} > ${maxEntries})`);
      if ("data" in entry) yield* writeBufferedEntry(state, entry);
      else yield* writeStreamedEntry(state, entry);
      if (state.offset >= MAX_TOTAL_BYTES) throw new Error("archive too large for a non-ZIP64 zip (4 GB limit)");
    }
    yield* zipTrailer(state, count);
  })();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (cancellation.signal.aborted) throw new Error("export cancelled");
        const next = await iterator.next();
        if (next.done) {
          opts.signal?.removeEventListener("abort", abort);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (err) {
        cancellation.abort();
        await iterator.return?.().catch(() => undefined);
        opts.signal?.removeEventListener("abort", abort);
        controller.error(err);
      }
    },
    async cancel() {
      cancellation.abort();
      await iterator.return?.();
      opts.signal?.removeEventListener("abort", abort);
    },
  });
}

/** Counters a single entry write carries between the stream loop and the entry helpers. */
interface ZipWriteState {
  encoder: TextEncoder;
  signal: AbortSignal;
  maxInputBytes: number;
  /** Central-directory records retained until the trailer is emitted. */
  centrals: Uint8Array[];
  /** Running byte offset of the next local header within the archive. */
  offset: number;
  /** Bytes claimed by entry metadata up front; streamed entries may declare none. */
  declaredInput: number;
  /** Bytes actually read; streamed entries are re-checked here because a file can grow. */
  observedInput: number;
}

/** DEFLATE a fully-buffered entry, falling back to STORE when compression would expand it. */
async function* writeBufferedEntry(state: ZipWriteState, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const { encoder, signal, maxInputBytes } = state;
  const nameBytes = encoder.encode(entry.name);
  if (!nameBytes.length || nameBytes.length > 0xffff) throw new Error("invalid zip entry name");
  const { time, date } = dosDateTime(entry.modified ?? new Date());
  state.declaredInput += entry.data.length;
  state.observedInput += entry.data.length;
  if (state.declaredInput > maxInputBytes || state.observedInput > maxInputBytes) throw new Error(`export exceeds ${maxInputBytes} byte limit`);
  const compressed = new Uint8Array(await deflate(entry.data));
  if (signal.aborted) throw new Error("export cancelled");
  const payload = compressed.length < entry.data.length ? compressed : entry.data;
  const method = payload === compressed ? 8 : 0;
  const crc = crc32(entry.data);
  const local = zipLocal(nameBytes.length, 0x0800, method, time, date, crc, payload.length, entry.data.length);
  yield local; yield nameBytes; yield payload;
  state.centrals.push(zipCentral(nameBytes.length, 0x0800, method, time, date, crc, payload.length, entry.data.length, state.offset), nameBytes);
  state.offset += local.length + nameBytes.length + payload.length;
}

/** Store a source-produced entry: unknown CRC and sizes require the PKZIP data-descriptor flag. */
async function* writeStreamedEntry(state: ZipWriteState, entry: ZipStreamEntry): AsyncGenerator<Uint8Array> {
  const { encoder, signal, maxInputBytes } = state;
  const nameBytes = encoder.encode(entry.name);
  if (!nameBytes.length || nameBytes.length > 0xffff) throw new Error("invalid zip entry name");
  const { time, date } = dosDateTime(entry.modified ?? new Date());
  const knownSize = entry.size;
  if (knownSize !== undefined && (!Number.isSafeInteger(knownSize) || knownSize < 0)) throw new Error("invalid zip entry size");
  state.declaredInput += knownSize ?? 0;
  if (state.declaredInput > maxInputBytes) throw new Error(`export exceeds ${maxInputBytes} byte limit`);
  const local = zipLocal(nameBytes.length, 0x0808, 0, time, date, 0, 0, 0);
  yield local; yield nameBytes;
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of entry.open(signal)) {
    if (signal.aborted) throw new Error("export cancelled");
    size += chunk.length;
    state.observedInput += chunk.length;
    if (size >= MAX_TOTAL_BYTES || state.observedInput > maxInputBytes) throw new Error(`export exceeds ${maxInputBytes} byte limit`);
    crc = crc32Update(crc, chunk);
    yield chunk;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const descriptor = new DataView(new ArrayBuffer(16));
  descriptor.setUint32(0, 0x08074b50, true); descriptor.setUint32(4, crc, true);
  descriptor.setUint32(8, size, true); descriptor.setUint32(12, size, true);
  yield new Uint8Array(descriptor.buffer);
  state.centrals.push(zipCentral(nameBytes.length, 0x0808, 0, time, date, crc, size, size, state.offset), nameBytes);
  state.offset += local.length + nameBytes.length + size + 16;
}

/** Emit the retained central directory, then the end-of-central-directory record. */
function* zipTrailer(state: ZipWriteState, count: number): Generator<Uint8Array> {
  const centralSize = state.centrals.reduce((n, part) => n + part.length, 0);
  for (const part of state.centrals) yield part;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, state.offset, true);
  yield new Uint8Array(end.buffer);
}

function crc32Update(crc: number, buf: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return c >>> 0;
}

function zipLocal(nameLength: number, flags: number, method: number, time: number, date: number, crc: number, compressedSize: number, size: number): Uint8Array {
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, flags, true); local.setUint16(8, method, true);
  local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
  local.setUint32(18, compressedSize, true); local.setUint32(22, size, true); local.setUint16(26, nameLength, true); local.setUint16(28, 0, true);
  return new Uint8Array(local.buffer);
}

function zipCentral(nameLength: number, flags: number, method: number, time: number, date: number, crc: number, compressedSize: number, size: number, offset: number): Uint8Array {
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, flags, true); central.setUint16(10, method, true);
  central.setUint16(12, time, true); central.setUint16(14, date, true); central.setUint32(16, crc, true); central.setUint32(20, compressedSize, true); central.setUint32(24, size, true);
  central.setUint16(28, nameLength, true); central.setUint16(30, 0, true); central.setUint16(32, 0, true); central.setUint16(34, 0, true); central.setUint16(36, 0, true); central.setUint32(38, 0, true); central.setUint32(42, offset, true);
  return new Uint8Array(central.buffer);
}

const MAX_ENTRIES = 0xffff;
const MAX_TOTAL_BYTES = 0xffffffff;

/** Build a complete .zip. Throws if the result would need ZIP64, rather than emitting a broken file. */
export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  // `>=`, not `>`: 0xFFFF and 0xFFFFFFFF are the reserved "look in the ZIP64 extra field" sentinels,
  // so writing one literally into a non-ZIP64 header makes strict readers go looking for ZIP64 data
  // that was never emitted. Refuse before we can encode a sentinel.
  if (entries.length >= MAX_ENTRIES) {
    throw new Error(`too many files for a non-ZIP64 archive (${entries.length} >= ${MAX_ENTRIES})`);
  }
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = new Uint8Array(await deflate(entry.data));
    // DEFLATE can expand incompressible input; fall back to STORED so an entry never grows.
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const crc = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    locals.push(new Uint8Array(local.buffer), nameBytes, payload);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory header signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, method, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, payload.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true); // relative offset of local header
    centrals.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + payload.length;
    if (offset >= MAX_TOTAL_BYTES) throw new Error("archive too large for a non-ZIP64 zip (4 GB limit)");
  }

  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(8, entries.length, true); // entries on this disk
  end.setUint16(10, entries.length, true); // entries total
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true); // offset of central directory

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, part) => n + part.length, 0)));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

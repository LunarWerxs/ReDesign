import fs from "node:fs";
import path from "node:path";

// ROOT = the app's base dir. In dev (`bun run src/index.ts`) this file is src/util.ts, so ROOT is the
// repo root. When packaged as a single compiled binary (`bun --compile`, see scripts/build.ts),
// import.meta.dir is a VIRTUAL bundle path, so the real files the app reads at runtime (src/config,
// src/web/dist, .env, output/, input/, reference/) live NEXT TO the executable instead. Detect the
// compiled case by the absence of package.json at the dev-resolved root, and fall back to the
// executable's directory. Dev behaviour is unchanged (the dev root always has package.json).
const DEV_ROOT = path.resolve(import.meta.dir, "..");
const ROOT = fs.existsSync(path.join(DEV_ROOT, "package.json")) ? DEV_ROOT : path.dirname(process.execPath);

// ---------------------------------------------------------------------------
// .env loading (zero-dependency)
// ---------------------------------------------------------------------------
// Parses KEY=VALUE lines. Ignores blank lines and `#` comments. Does not do
// shell-style expansion. Values are taken verbatim (trimmed, optional quotes
// stripped). Already-set process.env wins so callers can override.
function loadEnv(envPath?: string): Record<string, string> {
  const file = envPath || path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim(); // tolerate `export KEY=...`
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return parsed;
}

// Collect a key pool for an env var, supporting both comma-separated single
// var (FOO=a,b,c) and indexed form (FOO_1=a, FOO_2=b). Dedupes, drops blanks.
function getKeyPool(envName: string): string[] {
  const out: string[] = [];
  const direct = process.env[envName];
  if (direct) out.push(...direct.split(","));
  // indexed: FOO_1, FOO_2, ...
  const re = new RegExp(`^${envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)$`);
  for (const k of Object.keys(process.env)) {
    if (re.test(k)) out.push(...String(process.env[k]).split(","));
  }
  const cleaned = out.map((s) => s.trim()).filter(Boolean);
  return [...new Set(cleaned)];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Mask a secret for display: keep a short prefix + suffix.
function maskKey(key?: string | null): string {
  if (!key) return "(none)";
  const s = String(key);
  if (s.length <= 12) return `${s.slice(0, 3)}...`;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

// Stable short fingerprint of a key so state files never store the secret.
function keyId(key: string): string {
  let h = 5381;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `k${h.toString(36)}`;
}

// Slug that preserves unicode letters/numbers so non-ASCII names don't all
// collapse to the same token (which would collide input ids and overwrite
// outputs). Falls back to a short fingerprint when nothing usable remains.
function slugify(str: unknown): string {
  const s = String(str);
  let out: string;
  try {
    out = s.normalize("NFKC").replace(/[^\p{L}\p{N}\s._-]/gu, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80);
  } catch (_) {
    out = s.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80);
  }
  return out || `item-${keyId(s).slice(1)}`;
}

// ASCII-only slug used for stable ids (model/prompt ids), as opposed to
// slugify() above which preserves unicode for display-facing names.
function asciiSlug(label: unknown, fallback: string): string {
  const base = String(label || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || fallback;
}

interface SlugListItem {
  id?: string | null;
}

// Derive a unique id from a label against a list of existing entries, adding
// a `-2`, `-3`, ... suffix on collision. `existingId` is excluded from the
// collision check so re-saving an item under its own id doesn't self-collide.
function uniqueSlugId(list: SlugListItem[], label: unknown, existingId: string | null | undefined, fallback: string): string {
  const taken = new Set(list.map((item) => item.id).filter((id): id is string => !!id && id !== existingId));
  const base = asciiSlug(label, fallback);
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

type SelectionInput =
  | null
  | undefined
  | string
  | string[]
  | Record<string, unknown>;

// Normalize a flexible selection ('all'/'*' | csv-string | array | an object
// keyed by one of `extraKeys`) to a plain array of ids. Falsy selections
// return []; 'all'/'*' return ['all'] as a sentinel for "everything" (callers
// that need the raw items instead of ids check for this sentinel). csv
// strings are split on ',' and trimmed, blanks dropped.
function normalizeSelectionIds(selection: SelectionInput, { extraKeys = ["ids"] }: { extraKeys?: string[] } = {}): string[] {
  if (!selection) return [];
  if (selection === "all" || selection === "*") return ["all"];
  let ids: unknown = selection;
  if (Array.isArray(selection)) {
    ids = selection;
  } else if (typeof selection === "object") {
    ids = [];
    for (const key of extraKeys) {
      const val = (selection as Record<string, unknown>)[key];
      if (Array.isArray(val)) {
        ids = val;
        break;
      }
    }
  }
  if (typeof ids === "string") ids = ids.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.isArray(ids) ? ids : [];
}

// Mask anything that looks like an API key so secrets can never reach disk,
// logs, manifests, or HTTP responses (e.g. via an echoed provider error body).
function redactSecrets(str?: string | null): string | null | undefined {
  if (!str) return str;
  return String(str)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-...REDACTED")
    .replace(/sk-proj-[A-Za-z0-9_-]{8,}/g, "sk-proj-...REDACTED")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza...REDACTED")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-...REDACTED");
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface ResolveInsideError extends Error {
  status?: number;
}

/** Resolve `relPath` against `baseDir`, throwing a `status`-carrying Error if it would escape
 *  `baseDir` (path traversal). `allowBaseItself` controls whether the base dir's own path is a
 *  valid result (true for file-serving roots, false for per-id dirs like a run id resolving to
 *  the bare OUTPUT_DIR, which is never a valid run). Shared by fileServing.ts (file/output serving)
 *  and store.ts (run id -> run dir), which used to each hand-roll this with opposite defaults for
 *  the `full === base` edge case. */
function resolveInside(
  baseDir: string,
  relPath: unknown,
  { allowBaseItself = true, decode = true }: { allowBaseItself?: boolean; decode?: boolean } = {}
): { baseResolved: string; full: string } {
  let decoded = String(relPath || "");
  if (decode) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch (_) {
      const err = new Error("Bad request") as ResolveInsideError;
      err.status = 400;
      throw err;
    }
  }
  const baseResolved = path.resolve(baseDir);
  const full = path.resolve(baseResolved, decoded.replace(/^([/\\])+/, ""));
  const isBaseItself = full === baseResolved;
  if ((isBaseItself && !allowBaseItself) || (!isBaseItself && !full.startsWith(baseResolved + path.sep))) {
    const err = new Error("Forbidden") as ResolveInsideError;
    err.status = 403;
    throw err;
  }
  return { baseResolved, full };
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

// Atomic-ish JSON write (write temp then rename) to avoid corrupt state files.
// The temp name includes the pid so two processes never clobber each other's
// temp file mid-write (the final rename is atomic; last writer wins the file).
function writeJSON(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const IMAGE_EXTS = Object.keys(MIME_BY_EXT);

function mimeForFile(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || "image/png";
}

function isImageFile(file: string): boolean {
  return IMAGE_EXTS.includes(path.extname(file).toLowerCase());
}

interface ImagePayload {
  mime: string;
  data: string;
  bytes: number;
}

// Read an image file as a base64 payload usable by every provider adapter.
function imageToBase64(file: string): ImagePayload {
  const data = fs.readFileSync(file).toString("base64");
  return { mime: mimeForFile(file), data, bytes: data.length };
}

// ---------------------------------------------------------------------------
// Bounded-concurrency map. Runs `worker(item, index)` over `items` with at
// most `limit` in flight. Never rejects, failures are captured per item so a
// single bad job can't sink the whole run.
// ---------------------------------------------------------------------------
type MapLimitResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<MapLimitResult<R>[]> {
  const results = new Array<MapLimitResult<R>>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit | 0 || 1, items.length || 1));
  async function runner(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i] as T, i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  const runners: Promise<void>[] = [];
  for (let i = 0; i < n; i++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

// Pretty console logging with light color (auto-disabled when not a TTY).
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const C = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

export {
  ROOT,
  loadEnv,
  getKeyPool,
  sleep,
  maskKey,
  keyId,
  slugify,
  asciiSlug,
  uniqueSlugId,
  normalizeSelectionIds,
  ensureDir,
  resolveInside,
  readJSON,
  writeJSON,
  mimeForFile,
  isImageFile,
  imageToBase64,
  IMAGE_EXTS,
  mapLimit,
  redactSecrets,
  C,
};
export type { ImagePayload, SelectionInput, MapLimitResult, ResolveInsideError };

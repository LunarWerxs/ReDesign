import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import * as store from "../../store";
import { buildZipStream, type ZipInputEntry, type ZipStreamEntry } from "../../zip";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";

const EXPORT_MAX_BYTES = 512 * 1024 * 1024;
const EXPORT_MAX_ENTRIES = 0xffff - 1;
function safeArchiveName(value: string): string { return value.replace(/[^\w.-]+/g, "_") || "run"; }
function outputName(file: string, fallback: string): string {
  const parts = file.split("/").slice(1);
  return !parts.length || parts.some((part) => !part || part === "." || part === "..") ? fallback : parts.join("/");
}
function archiveHref(name: string): string { return name.split("/").map((part) => encodeURIComponent(part)).join("/"); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c] || c); }
function comparisonIndex(items: { name: string; label: string }[]): Uint8Array {
  const rows = items.map(({ name, label }) => `<article><h2>${escapeHtml(label)}</h2><iframe sandbox src="${escapeHtml(archiveHref(name))}"></iframe></article>`).join("\n");
  return new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>Run comparison</title><style>body{font:14px system-ui;margin:20px;background:#eee}article{background:#fff;margin:16px 0;padding:12px}iframe{width:100%;height:700px;border:1px solid #ccc}</style><h1>Run comparison</h1>${rows}`);
}
function isBelow(root: string, target: string): boolean { return target.startsWith(root + path.sep); }

async function* readChunks(file: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const input = fs.createReadStream(file);
  const onAbort = () => input.destroy(new Error("export cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of input) { if (signal.aborted) throw new Error("export cancelled"); yield chunk; }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!input.destroyed) input.destroy();
  }
}

async function fileEntry(rootReal: string, file: string, name: string): Promise<ZipStreamEntry | null> {
  try {
    const [real, stat] = await Promise.all([fs.promises.realpath(file), fs.promises.stat(file)]);
    if (!stat.isFile() || !isBelow(rootReal, real)) return null;
    return { name, size: stat.size, modified: stat.mtime, open: (signal) => readChunks(real, signal) };
  } catch { return null; }
}
async function addFile(plan: ZipInputEntry[], rootReal: string, file: string, name: string): Promise<boolean> {
  const entry = await fileEntry(rootReal, file, name);
  if (!entry) return false;
  plan.push(entry);
  return true;
}
function checkPlan(entries: ZipInputEntry[]): void {
  if (entries.length > EXPORT_MAX_ENTRIES) throw Object.assign(new Error(`too many files for export (${entries.length} > ${EXPORT_MAX_ENTRIES})`), { status: 413 });
  const bytes = entries.reduce((total, entry) => total + ("data" in entry ? entry.data.length : entry.size ?? 0), 0);
  if (bytes > EXPORT_MAX_BYTES) throw Object.assign(new Error(`export exceeds ${EXPORT_MAX_BYTES} byte limit`), { status: 413 });
}

/** Resolve and stat every selected file before headers are sent; reads stay lazy for the ZIP stream. */
async function bundlePlan(id: string, shortlistOnly: boolean): Promise<ZipInputEntry[]> {
  const manifest = store.readManifest(id);
  if (!manifest) throw Object.assign(new Error("run not found"), { status: 404 });
  const root = store.runDir(id);
  const rootReal = await fs.promises.realpath(root);
  const review = store.getReview(id);
  const wanted = new Set(review.shortlist);
  const jobs = (manifest.jobs || []).filter((job) => job.status === "ok" && typeof job.file === "string" && (!shortlistOnly || wanted.has(String(job.id))));
  const entries: ZipInputEntry[] = [];
  const indexItems: { name: string; label: string }[] = [];
  for (const job of jobs) {
    const rel = String(job.file).replaceAll("\\", "/");
    const name = outputName(rel, `${job.id}.html`);
    const abs = path.resolve(root, ...rel.split("/").slice(1));
    if (!isBelow(root, abs)) continue;
    if (!await addFile(entries, rootReal, abs, name)) continue;
    await addFile(entries, rootReal, `${abs.replace(/\.html?$/i, "")}.meta.json`, `${name.replace(/\.html?$/i, "")}.meta.json`);
    indexItems.push({ name, label: String(job.id) });
  }
  entries.push({ name: "review.json", data: new TextEncoder().encode(JSON.stringify(review, null, 2)) });
  async function walk(dir: string, prefix: string): Promise<void> {
    let children: fs.Dirent[];
    try { children = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const file = path.join(dir, child.name);
      const archiveName = `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        try { if (isBelow(rootReal, await fs.promises.realpath(file))) await walk(file, archiveName); } catch { /* absent or inaccessible */ }
      } else if (child.isFile() || child.isSymbolicLink()) {
        // fileEntry resolves links and accepts only targets inside the real run root.
        await addFile(entries, rootReal, file, archiveName);
      }
    }
  }
  if (!shortlistOnly) {
    for (const name of ["manifest.json", "spec.json"]) await addFile(entries, rootReal, path.join(root, name), name);
    await walk(path.join(root, "assets"), "assets");
  } else {
    // Outputs embed their cropped logos and photos as ../assets/crops/..., so a shortlist zip
    // carries the crops too, or every shortlisted page would open with broken images.
    await walk(path.join(root, "assets", "crops"), "assets/crops");
  }
  entries.push({ name: "comparison.html", data: comparisonIndex(indexItems) });
  checkPlan(entries);
  return entries;
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/runs/:id/download", requireSameOrigin(), async (c) => {
    const id = c.req.param("id");
    let manifest: store.Manifest | null;
    try { manifest = store.readManifest(id); } catch { return c.json({ error: "invalid run id" }, 400); }
    if (!manifest) return c.json({ error: "run not found" }, 404);
    const shortlistOnly = c.req.query("shortlist") === "1";
    let entries: ZipInputEntry[];
    try { entries = await bundlePlan(id, shortlistOnly); }
    catch (error) {
      const message = error instanceof Error ? error.message : "unable to prepare export";
      const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 500;
      return c.json({ error: message }, status as 404 | 413 | 500);
    }
    const stream = buildZipStream(entries, { maxInputBytes: EXPORT_MAX_BYTES, maxEntries: EXPORT_MAX_ENTRIES, signal: c.req.raw.signal });
    return c.body(stream, 200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${safeArchiveName(id)}${shortlistOnly ? "-shortlist" : ""}.zip"`, "cache-control": "no-store" });
  });
}

import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { buildDesignMd } from "../../design-md";
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
function jobLabel(job: NonNullable<store.Manifest["jobs"]>[number]): string {
  const model = typeof job.modelId === "string" ? job.modelId : "";
  const prompt = typeof job.promptId === "string" ? job.promptId : "";
  return model ? `${model}${prompt ? ` / ${prompt}` : ""} (${String(job.id)})` : String(job.id);
}
/** Cap on the HTML read for a DESIGN.md; a generated page is far smaller. */
const DESIGN_MD_MAX_HTML_BYTES = 4 * 1024 * 1024;
async function designMdFor(rootReal: string, abs: string, label: string, file: string, runId: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(abs);
    if (!isBelow(rootReal, real)) return null;
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || stat.size > DESIGN_MD_MAX_HTML_BYTES) return null;
    return buildDesignMd(await fs.promises.readFile(real, "utf8"), { label, file, runId });
  } catch { return null; }
}

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
  // A shortlist is the user's pick, so it carries a DESIGN.md handoff per output, and the
  // first-starred one also becomes the archive's top-level DESIGN.md.
  const designMds = new Map<string, Uint8Array>();
  for (const job of jobs) {
    const rel = String(job.file).replaceAll("\\", "/");
    const name = outputName(rel, `${job.id}.html`);
    const abs = path.resolve(root, ...rel.split("/").slice(1));
    if (!isBelow(root, abs)) continue;
    if (!await addFile(entries, rootReal, abs, name)) continue;
    await addFile(entries, rootReal, `${abs.replace(/\.html?$/i, "")}.meta.json`, `${name.replace(/\.html?$/i, "")}.meta.json`);
    indexItems.push({ name, label: String(job.id) });
    if (shortlistOnly && /\.html?$/i.test(name)) {
      const doc = await designMdFor(rootReal, abs, jobLabel(job), name, id);
      if (doc) {
        const data = new TextEncoder().encode(doc);
        entries.push({ name: `${name.replace(/\.html?$/i, "")}.DESIGN.md`, data });
        designMds.set(String(job.id), data);
      }
    }
  }
  const chosen = review.shortlist.find((jobId) => designMds.has(jobId));
  if (chosen) entries.push({ name: "DESIGN.md", data: designMds.get(chosen) as Uint8Array });
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

  // One chosen output as a DESIGN.md handoff: tokens, components and rules read from its HTML.
  app.get("/api/runs/:id/design-md", requireSameOrigin(), async (c) => {
    const id = c.req.param("id");
    const jobId = c.req.query("job") || "";
    let manifest: store.Manifest | null;
    try { manifest = store.readManifest(id); } catch { return c.json({ error: "invalid run id" }, 400); }
    if (!manifest) return c.json({ error: "run not found" }, 404);
    const job = (manifest.jobs || []).find((j) => String(j.id) === jobId && j.status === "ok" && typeof j.file === "string");
    if (!job) return c.json({ error: "job not found or has no output" }, 404);
    const root = store.runDir(id);
    const rel = String(job.file).replaceAll("\\", "/");
    const abs = path.resolve(root, ...rel.split("/").slice(1));
    if (!isBelow(root, abs) || !/\.html?$/i.test(abs)) return c.json({ error: "output is not an HTML redesign" }, 404);
    const doc = await designMdFor(await fs.promises.realpath(root), abs, jobLabel(job), outputName(rel, `${jobId}.html`), id);
    if (!doc) return c.json({ error: "output could not be read" }, 404);
    return c.body(doc, 200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${safeArchiveName(`${id}-${jobId}`)}.DESIGN.md"`, "cache-control": "no-store" });
  });
}

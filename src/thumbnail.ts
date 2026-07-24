/**
 * Durable run thumbnails, with backfill for runs that never got one.
 *
 * A run's gallery thumbnail (see src/web/src/components/app/viewer/RunGallery.vue) is its own
 * copy under the run dir — runner/reimagine.ts's persistRunThumbnail writes it at run start by
 * copying the first input screenshot. Runs created before that existed (or whose copy failed)
 * have no `thumb`, and their original input screenshot is long gone (input/ is scratch space that
 * gets emptied), so their thumbnail 404s.
 *
 * `ensureRunThumbnail` heals that on demand, harvesting the best image still on disk and making it
 * DURABLE so it only ever happens once per run:
 *   1. an existing thumb → use it.
 *   2. the original input screenshot, if input/ still has it → copy it into the run dir as the
 *      thumb (so it survives the next input/ sweep) and record it on the manifest.
 *   3. otherwise render the run's first successful OUTPUT (the generated HTML, which DOES persist)
 *      to a PNG with headless Chromium — the "harvest a screenshot from a preview" fallback.
 *   4. nothing renderable (no outputs, no browser) → null, and the gallery shows its placeholder.
 *
 * Renders are capped at MAX_CONCURRENT_RENDERS (Chromium is heavy) and de-duplicated per run, so a
 * gallery of 30 thumbnail-less runs loading at once can't fork 30 browsers.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as store from "./store";
import { INPUT_DIR } from "./inputResolver";
import { resolveChromiumBrowser } from "./portable-window.mjs";

const RENDER_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_RENDERS = 2;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface RunThumbnail {
  /** Absolute path of the image file to serve. */
  abs: string;
  mime: string;
}

// ── render throttle (a tiny semaphore) ───────────────────────────────────────────────────────
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];
async function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return;
  }
  await new Promise<void>((resolve) => renderWaiters.push(resolve));
  activeRenders++;
}
function releaseRenderSlot(): void {
  activeRenders--;
  renderWaiters.shift()?.();
}

/** Render an HTML file to a PNG at `outPng` with headless Chromium. Rejects on failure/timeout. */
export async function renderHtmlToPng(fullHtml: string, outPng: string, size = { width: 1200, height: 900 }): Promise<void> {
  const browser = resolveChromiumBrowser();
  if (!browser) throw new Error("No Edge or Chrome install found to render a preview");
  const profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-thumb-"));
  try {
    await acquireRenderSlot();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          browser.path,
          [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            `--user-data-dir=${path.join(profileDir, "profile")}`,
            `--window-size=${size.width},${size.height}`,
            // let scripts/animations settle instantly instead of wall-clock waiting
            "--virtual-time-budget=4000",
            `--screenshot=${outPng}`,
            pathToFileURL(fullHtml).href,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Render timed out"));
        }, RENDER_TIMEOUT_MS);
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(outPng)) resolve();
          else reject(new Error(`Render failed (${browser.name} exited ${code})`));
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      releaseRenderSlot();
    }
  } finally {
    fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

function mimeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/** The thumb file recorded on a manifest, resolved to an absolute path if it still exists. */
function existingThumb(runId: string, m: store.Manifest | null): string | null {
  const rel = m && typeof m.thumb === "string" ? m.thumb : "";
  if (!rel) return null;
  const abs = path.join(store.runDir(runId), rel.split("/").join(path.sep));
  return fs.existsSync(abs) ? abs : null;
}

/** The run's first input screenshot, resolved under input/ if that scratch file still exists. */
function survivingInput(m: store.Manifest | null): string | null {
  const inputs = (m?.inputs as { preview?: unknown }[] | undefined) || [];
  for (const input of inputs) {
    const rel = typeof input?.preview === "string" ? input.preview : "";
    if (!rel) continue;
    const abs = path.join(INPUT_DIR, rel.split("/").join(path.sep));
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** The run's first successful output HTML, resolved under output/ if it still exists. */
function firstOutputHtml(m: store.Manifest | null): string | null {
  const jobs = (m?.jobs as { status?: unknown; file?: unknown }[] | undefined) || [];
  for (const job of jobs) {
    if (job?.status !== "ok" || typeof job.file !== "string" || !job.file) continue;
    const abs = path.join(store.OUTPUT_DIR, job.file.split("/").join(path.sep));
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Record `thumbName` (a run-dir-relative filename) on the manifest so summaries pick it up. */
function recordThumb(runId: string, m: store.Manifest, thumbName: string): void {
  try {
    store.writeManifest(runId, { ...m, thumb: thumbName });
  } catch {
    /* the file is on disk regardless; a failed manifest write just means we may re-copy later */
  }
}

const inFlight = new Map<string, Promise<RunThumbnail | null>>();

/**
 * Return an image to use as `runId`'s thumbnail, creating a durable one if needed. See the module
 * header for the priority order. De-duplicated per run so concurrent gallery requests share one
 * render. Returns null when nothing renderable remains.
 */
export function ensureRunThumbnail(runId: string): Promise<RunThumbnail | null> {
  const pending = inFlight.get(runId);
  if (pending) return pending;
  const p = ensureRunThumbnailUncached(runId).finally(() => inFlight.delete(runId));
  inFlight.set(runId, p);
  return p;
}

async function ensureRunThumbnailUncached(runId: string): Promise<RunThumbnail | null> {
  let dir: string;
  let m: store.Manifest | null;
  try {
    dir = store.runDir(runId); // validates the id (throws on traversal)
    m = store.readManifest(runId);
  } catch {
    return null;
  }

  // 1. Already have one.
  const have = existingThumb(runId, m);
  if (have) return { abs: have, mime: mimeFor(have) };

  // 2. The original input screenshot still exists — copy it in so it survives the next input/ sweep.
  const input = survivingInput(m);
  if (input) {
    const name = `thumb${(path.extname(input) || ".png").toLowerCase()}`;
    const abs = path.join(dir, name);
    try {
      fs.copyFileSync(input, abs);
      if (m) recordThumb(runId, m, name);
      return { abs, mime: mimeFor(abs) };
    } catch {
      // Copy failed (permissions, race) — fall back to serving the input directly, un-persisted.
      return { abs: input, mime: mimeFor(input) };
    }
  }

  // 3. Harvest from a surviving output preview by rendering it.
  const output = firstOutputHtml(m);
  if (output) {
    const abs = path.join(dir, "thumb.png");
    try {
      await renderHtmlToPng(output, abs);
      if (m) recordThumb(runId, m, "thumb.png");
      return { abs, mime: "image/png" };
    } catch {
      return null;
    }
  }

  // 4. Nothing to show.
  return null;
}

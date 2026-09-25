/**
 * POST /api/output/open; GET /api/output/screenshot; GET /api/output/contrast;
 * GET /output/*, /output-raw/* file serving.
 * Ported from server.js + server/fileServing.js.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { serveFile, serveOutputWrapper, resolveOutputHtmlFile, launchPath } from "../fileServing";
import * as store from "../../store";
import { renderHtmlToPng } from "../../thumbnail";
import { decodePng, scoreTextContrast, type ContrastLevel, type ContrastReport } from "../../contrast";

// A contrast check renders the output in headless Chromium (seconds), and an output file rarely
// changes after it is written, so reports are remembered per file + mtime + level.
const CONTRAST_CACHE_MAX = 200;
const contrastCache = new Map<string, Promise<ContrastReport>>();

async function outputContrast(full: string, level: ContrastLevel): Promise<ContrastReport> {
  const key = `${full}|${(await fs.promises.stat(full)).mtimeMs}|${level}`;
  const hit = contrastCache.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-contrast-"));
    const png = path.join(tmpDir, "shot.png");
    try {
      // The run dir is served too, so cropped logos (../assets/crops/...) render as the viewer shows them.
      const runRoot = path.join(store.OUTPUT_DIR, path.relative(store.OUTPUT_DIR, full).split(path.sep)[0] || "");
      const { textBoxes } = await renderHtmlToPng(full, png, { width: 1440, height: 900 }, { assetRoot: runRoot, collectTextBoxes: true });
      return scoreTextContrast(decodePng(await fs.promises.readFile(png)), textBoxes, level);
    } finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  // A failed render (no browser, timeout) must not be remembered: the next click retries.
  pending.catch(() => contrastCache.delete(key));
  if (contrastCache.size >= CONTRAST_CACHE_MAX) {
    const oldest = contrastCache.keys().next().value;
    if (oldest !== undefined) contrastCache.delete(oldest);
  }
  contrastCache.set(key, pending);
  return pending;
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/output-raw/*", (c) => {
    const url = new URL(c.req.url);
    const rel = url.pathname.slice("/output-raw/".length);
    return serveFile(c, store.OUTPUT_DIR, rel, {
      download: url.searchParams.has("download"),
      sandbox: rel.toLowerCase().endsWith(".html"),
      measure: url.searchParams.has("measure"),
    });
  });

  app.get("/output/*", (c) => {
    const url = new URL(c.req.url);
    const rel = url.pathname.slice("/output/".length);
    const isHtml = rel.toLowerCase().endsWith(".html");
    if (isHtml && !url.searchParams.has("download")) return serveOutputWrapper(c, rel);
    return serveFile(c, store.OUTPUT_DIR, rel, {
      download: url.searchParams.has("download"),
      sandbox: isHtml,
    });
  });

  // Rasterize an output HTML to PNG for download. The preview iframe is sandboxed WITHOUT
  // allow-same-origin (its document is unreadable from the SPA), so the capture is taken
  // server-side by headless Chromium (shared renderer, see src/thumbnail.ts renderHtmlToPng —
  // same engine that backfills gallery thumbnails).
  // Guarded like the mutating routes even though it is a GET: it spawns headless Chromium per
  // call, so it is a real compute side effect, and the shared guard is what rejects the null
  // Origin a sandboxed output iframe would send if it tried to drive it.
  app.get("/api/output/screenshot", requireSameOrigin(), async (c) => {
    const full = resolveOutputHtmlFile(c.req.query("file"));
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-shot-"));
    const png = path.join(tmpDir, "shot.png");
    try {
      // Serve the whole run dir (store.OUTPUT_DIR/<runId>), not only the page's folder: outputs
      // link their cropped logos as ../assets/crops/..., which would otherwise capture as broken.
      const runRoot = path.join(store.OUTPUT_DIR, path.relative(store.OUTPUT_DIR, full).split(path.sep)[0] || "");
      await renderHtmlToPng(full, png, { width: 1440, height: 900 }, { assetRoot: runRoot });
      const buf = await fs.promises.readFile(png);
      const base = path.basename(full).replace(/\.html?$/i, "").replace(/[^\w.-]+/g, "_") || "preview";
      return c.body(new Uint8Array(buf), 200, {
        "content-type": "image/png",
        "content-disposition": `attachment; filename="${base}.png"`,
        "cache-control": "no-store",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "screenshot failed";
      // No browser found is a capability gap (501); anything else is a render failure (500).
      const status = /Edge or Chrome/.test(message) ? 501 : 500;
      return c.json({ error: message }, status);
    } finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // WCAG text contrast judged from the rendered pixels (src/contrast.ts), so text over images,
  // gradients and translucent layers is rated as a visitor sees it. Same-origin guarded for the
  // same reason as the screenshot route: every uncached call spawns headless Chromium.
  app.get("/api/output/contrast", requireSameOrigin(), async (c) => {
    const full = resolveOutputHtmlFile(c.req.query("file"));
    const level: ContrastLevel = c.req.query("level") === "AAA" ? "AAA" : "AA";
    try {
      return c.json(await outputContrast(full, level));
    } catch (err) {
      const message = err instanceof Error ? err.message : "contrast check failed";
      const status = /Edge or Chrome/.test(message) ? 501 : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/output/open", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { target?: string; file?: string };
    const target = body.target === "folder" || body.target === "file" ? body.target : null;
    if (!target) return c.json({ error: "target must be folder or file" }, 400);
    const full = resolveOutputHtmlFile(body.file);
    launchPath(target === "folder" ? path.dirname(full) : full, target);
    return c.json({ ok: true });
  });
}

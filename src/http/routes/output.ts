/**
 * POST /api/output/open; GET /api/output/screenshot; GET /output/*, /output-raw/* file serving.
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
  app.get("/api/output/screenshot", async (c) => {
    const full = resolveOutputHtmlFile(c.req.query("file"));
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-shot-"));
    const png = path.join(tmpDir, "shot.png");
    try {
      await renderHtmlToPng(full, png, { width: 1440, height: 900 });
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

  app.post("/api/output/open", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { target?: string; file?: string };
    const target = body.target === "folder" || body.target === "file" ? body.target : null;
    if (!target) return c.json({ error: "target must be folder or file" }, 400);
    const full = resolveOutputHtmlFile(body.file);
    launchPath(target === "folder" ? path.dirname(full) : full, target);
    return c.json({ ok: true });
  });
}

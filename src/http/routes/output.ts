/**
 * POST /api/output/open; GET /output/*, /output-raw/* file serving. Ported from server.js +
 * server/fileServing.js.
 */
import path from "node:path";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { serveFile, serveOutputWrapper, resolveOutputHtmlFile, launchPath } from "../fileServing";
import * as store from "../../store";

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

  app.post("/api/output/open", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { target?: string; file?: string };
    const target = body.target === "folder" || body.target === "file" ? body.target : null;
    if (!target) return c.json({ error: "target must be folder or file" }, 400);
    const full = resolveOutputHtmlFile(body.file);
    launchPath(target === "folder" ? path.dirname(full) : full, target);
    return c.json({ ok: true });
  });
}

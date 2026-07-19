/**
 * Static PWA serving (Vite-built Vue UI under src/web/dist) + its traversal protection and cache
 * policy. Ported from server.js's `/assets/*` route + its `GET !/api/*` SPA fallback (previously
 * `serveFile(..., WEB_DIST, 'index.html')`). mountWeb() must be registered LAST so its `/*`
 * catch-all only catches routes no earlier route module owned (mirrors RepoYeti's mountWeb).
 */
import { join, normalize, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { Hono } from "hono";
import { serveFile } from "./fileServing";

/** Path to the built Vue UI (`src/web/dist`). Works in dev (relative to this source) and when
 * compiled (a `src/web/dist` shipped next to the binary), same two-candidate resolve as
 * util.ts's ROOT, kept local here since RepoYeti/DevWebUI's web dir sits at a different depth. */
function resolveWebRoot(): string {
  const devCandidate = normalize(join(import.meta.dir, "..", "web", "dist")); // dev: src/http/../web/dist
  const compiledCandidate = normalize(join(dirname(process.execPath), "src", "web", "dist")); // compiled: next to the binary
  const candidates = [devCandidate, compiledCandidate];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return devCandidate;
}
const WEB_ROOT = resolveWebRoot();

// Vite emits content-addressed (hash-in-name) files under /assets, cache them forever, exactly
// as server.js's `/assets/*` route did with `{ immutable: true }`.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Serve the SPA + assets with traversal protection.
 *
 * The SPA fallback to index.html applies to GET requests that are not `/api/*` and not one of
 * the other static-file route groups (input/reference/output/output-raw), matching server.js's
 * `if (method === 'GET' && !p.startsWith('/api/')) return serveFile(req, res, WEB_DIST,
 * 'index.html')`. Registered after every other route module, so this only runs for a genuine
 * miss (vue-router paths like "/", "/viewer", deep links).
 */
export function mountWeb(app: Hono): void {
  app.get("/assets/*", async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const rel = pathname.slice("/assets/".length);
    const filePath = normalize(join(WEB_ROOT, "assets", rel));
    if (!filePath.startsWith(normalize(join(WEB_ROOT, "assets")))) return c.text("Forbidden", 403);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return c.text("Not found", 404);
    return new Response(file, { headers: { "Cache-Control": IMMUTABLE_CACHE } });
  });

  app.get("/*", async (c) => {
    // Root-level static files Vite copied from public/ (favicon.ico, icon.svg, robots.txt, ...).
    // Vite drops these at the dist root, NOT under /assets/, so without this they'd hit the SPA
    // fallback below and the browser would get index.html (text/html) instead of the icon. Only
    // paths with a file extension are considered; vue-router deep links ("/", "/viewer") have none
    // and fall straight through to index.html. serveFile handles MIME/caching/traversal and returns
    // 404 for a genuine miss, in which case we still serve the SPA shell.
    const rel = new URL(c.req.url).pathname.replace(/^\/+/, "");
    if (rel && /\.[a-z0-9]+$/i.test(rel)) {
      const res = await serveFile(c, WEB_ROOT, rel);
      if (res.status !== 404) return res;
    }

    const index = Bun.file(join(WEB_ROOT, "index.html"));
    if (!(await index.exists())) {
      return c.text("Web UI not built, run: npm run build (dev: npm run dev:web)", 503);
    }
    return new Response(index, { headers: { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" } });
  });
}

export { WEB_ROOT };

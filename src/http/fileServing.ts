/**
 * Static-file + output-viewer serving: MIME lookup, safe path resolution, caching headers, the
 * "measure iframe height" HTML injection, the /output/*.html wrapper page, and launching an
 * output locally (Explorer/Finder/xdg-open). Ported from server/fileServing.js (Hono `Response`
 * instead of raw `res.writeHead`/`res.end`); behavior preserved 1:1.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as store from "../store";
import { resolveInside } from "../util";
import { hasOutputHeightMeasure, injectOutputHeightMeasure } from "../outputMeasure";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function escHtml(s: unknown): string {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ((({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c] as string),
  );
}

function encPathUrl(rel: string): string {
  return String(rel).split("/").map(encodeURIComponent).join("/");
}

function fileEtag(st: fs.Stats, suffix = ""): string {
  return `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${suffix}"`;
}

function requestFresh(c: Context, st: fs.Stats, etag: string): boolean {
  const inm = c.req.header("if-none-match");
  if (inm?.split(",").map((s) => s.trim()).includes(etag)) return true;
  const ims = c.req.header("if-modified-since");
  if (!ims) return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) && st.mtimeMs <= since + 1000;
}

interface ServeFileOptions {
  download?: boolean;
  sandbox?: boolean;
  immutable?: boolean;
  measure?: boolean;
}

/** Serve a file from a base dir, blocking path traversal outside that dir. `sandbox:true` adds a
 * CSP sandbox so model-generated HTML can't reach our origin/API even when opened directly in a
 * tab (the iframe also sandboxes it). Returns a Hono Response (never throws, errors are mapped
 * to a plain-text error response, matching the original send(res, status, message) behavior). */
async function serveFile(c: Context, baseDir: string, relPath: unknown, { download, sandbox, immutable, measure }: ServeFileOptions = {}): Promise<Response> {
  let full: string;
  try {
    full = resolveInside(baseDir, relPath).full;
  } catch (err) {
    const e = err as StatusError;
    return c.text(e.message || "Bad request", (e.status || 400) as ContentfulStatusCode);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
    if (!st.isFile()) throw new Error("not a file");
  } catch (_) {
    return c.text("Not found", 404);
  }

  const measured = !!measure && !download && path.extname(full).toLowerCase() === ".html";
  const etag = fileEtag(st, measured ? "-measure" : "");
  const headers: Record<string, string> = {
    "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Cache-Control": download ? "no-store" : immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
  };
  if (sandbox) headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
  if (download) {
    const safeName = path.basename(full).replace(/["\\\r\n]/g, "_");
    headers["Content-Disposition"] = `attachment; filename="${safeName}"`;
  }
  if (!download && requestFresh(c, st, etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (measured) {
    // Outputs written by this version already carry the measurement script (injected at write time
    // in runner/reimagine.ts), so they fall through to the streamed path below. Anything older is
    // migrated ONCE, here, on first view: inject, write the completed document back, then serve it.
    // That keeps a pre-existing run's auto-height working without every gallery card paying a full
    // synchronous read and regex scan on every request forever.
    const html = fs.readFileSync(full, "utf8");
    if (!hasOutputHeightMeasure(html)) {
      const injected = injectOutputHeightMeasure(html);
      // Temp file then rename, never a write in place. This is the user's generated output, the
      // artifact the whole app exists to produce, and a crash or a kill partway through an in-place
      // write leaves a truncated document with nothing to restore it from. Same pattern as
      // util.ts's writeJSON and the .env write in server/settings.ts.
      const tmp = `${full}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, injected);
        fs.renameSync(tmp, full);
      } catch (_) {
        // Read-only output dir, or a locked file: serve the injected copy anyway and try again on
        // the next view. Clean up the temp file so a failed migration can't litter the run folder.
        try {
          fs.rmSync(tmp, { force: true });
        } catch (_) {
          /* nothing further to do */
        }
      }
      // The ETag and Last-Modified above were computed from the PRE-migration stat, so they
      // describe a file that no longer exists. Serving them would let a client cache this
      // response under a validator the next request will not reproduce; drop them instead. The
      // migration happens once per file, so the caching loss is a one-off.
      headers["Cache-Control"] = "no-store";
      delete headers.ETag;
      delete headers["Last-Modified"];
      return new Response(injected, { status: 200, headers });
    }
  }
  return new Response(Bun.file(full), { status: 200, headers });
}

function outputRelFromFull(full: string): string {
  return path.relative(store.OUTPUT_DIR, full).split(path.sep).join("/");
}

function outputWrapperHtml(relPath: string): string {
  const rawUrl = `/output-raw/${encPathUrl(relPath)}`;
  const fileLabel = path.basename(relPath);
  const relJson = JSON.stringify(relPath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(fileLabel)}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
    iframe { display: block; width: 100vw; height: 100vh; border: 0; background: #fff; }
    .local-actions { position: fixed; top: 12px; right: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 8px; font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .local-actions button { border: 1px solid rgba(255,255,255,.22); border-radius: 999px; padding: 7px 10px; color: #fff; background: rgba(12,14,19,.74); box-shadow: 0 10px 30px rgba(0,0,0,.24); backdrop-filter: blur(10px); cursor: pointer; font-weight: 700; }
    .local-actions button:hover { background: rgba(25,30,42,.88); }
    .local-actions button:disabled { cursor: wait; opacity: .72; }
    .local-actions .close-actions { padding: 0; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 999px; font-size: 13px; line-height: 1; }
  </style>
</head>
<body>
  <iframe src="${escHtml(rawUrl)}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>
  <div class="local-actions" aria-label="Local file actions">
    <button type="button" data-open="folder" title="Open containing folder">Folder</button>
    <button type="button" data-open="file" title="Open this HTML file locally">Local file</button>
    <button type="button" class="close-actions" title="Hide these buttons" aria-label="Hide these buttons">&#10005;</button>
  </div>
  <script>
    const outputFile = ${relJson};
    async function openOutput(target, btn) {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Opening...';
      try {
        const res = await fetch('/api/output/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: outputFile, target })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || String(res.status));
        }
        btn.textContent = 'Opened';
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 900);
      } catch (err) {
        btn.textContent = 'Failed';
        btn.title = err && err.message ? err.message : 'Failed to open';
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1400);
      }
    }
    document.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openOutput(btn.dataset.open, btn));
    });
    const closeBtn = document.querySelector('.close-actions');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      const bar = document.querySelector('.local-actions');
      if (bar) bar.style.display = 'none';
    });
  </script>
</body>
</html>`;
}

async function serveOutputWrapper(c: Context, relPath: unknown): Promise<Response> {
  let full: string;
  try {
    full = resolveInside(store.OUTPUT_DIR, relPath).full;
  } catch (err) {
    const e = err as StatusError;
    return c.text(e.message || "Bad request", (e.status || 400) as ContentfulStatusCode);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
    if (!st.isFile()) throw new Error("not a file");
  } catch (_) {
    return c.text("Not found", 404);
  }
  return c.html(outputWrapperHtml(outputRelFromFull(full)));
}

function resolveOutputHtmlFile(relPath: unknown): string {
  const full = resolveInside(store.OUTPUT_DIR, relPath, { decode: false }).full;
  if (path.extname(full).toLowerCase() !== ".html") {
    throw statusError("Only HTML outputs can be opened locally", 400);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch (_) {
    throw statusError("Output not found", 404);
  }
  if (!st.isFile()) throw statusError("Output not found", 404);
  return full;
}

function launchPath(targetPath: string, target: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    if (target === "file") {
      command = "rundll32.exe";
      args = ["url.dll,FileProtocolHandler", targetPath];
    } else {
      command = "explorer.exe";
      args = [targetPath];
    }
  } else if (process.platform === "darwin") {
    command = "open";
    args = [targetPath];
  } else {
    command = "xdg-open";
    args = [targetPath];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export {
  MIME,
  serveFile,
  serveOutputWrapper,
  resolveOutputHtmlFile,
  launchPath,
  statusError,
};
export type { StatusError, ServeFileOptions };

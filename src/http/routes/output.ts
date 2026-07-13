/**
 * POST /api/output/open; GET /api/output/screenshot; GET /output/*, /output-raw/* file serving.
 * Ported from server.js + server/fileServing.js.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { serveFile, serveOutputWrapper, resolveOutputHtmlFile, launchPath } from "../fileServing";
import * as store from "../../store";
import { resolveChromiumBrowser } from "../../portable-window.mjs";

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

  // Rasterize an output HTML to PNG. The preview iframe is sandboxed WITHOUT
  // allow-same-origin (its document is unreadable from the SPA), so screenshots are taken
  // server-side: a system Chromium (Edge/Chrome, same discovery the portable window uses;
  // no bundled-browser dependency) renders the file headlessly and hands back the pixels.
  // A throwaway --user-data-dir keeps the capture isolated from any running Edge/Chrome
  // singleton (without it the spawn hands off to the live browser and writes nothing).
  app.get("/api/output/screenshot", async (c) => {
    const full = resolveOutputHtmlFile(c.req.query("file"));
    const browser = resolveChromiumBrowser();
    if (!browser) return c.json({ error: "No Edge or Chrome install found to render the screenshot" }, 501);

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-shot-"));
    const png = path.join(tmpDir, "shot.png");
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
            `--user-data-dir=${path.join(tmpDir, "profile")}`,
            "--window-size=1440,900",
            // let scripts/animations settle instantly instead of wall-clock waiting
            "--virtual-time-budget=4000",
            `--screenshot=${png}`,
            pathToFileURL(full).href,
          ],
          { stdio: "ignore", windowsHide: true },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Screenshot render timed out"));
        }, 30_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(png)) resolve();
          else reject(new Error(`Screenshot render failed (${browser.name} exited ${code})`));
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const buf = await fs.promises.readFile(png);
      const base = path.basename(full).replace(/\.html?$/i, "").replace(/[^\w.-]+/g, "_") || "preview";
      return c.body(new Uint8Array(buf), 200, {
        "content-type": "image/png",
        "content-disposition": `attachment; filename="${base}.png"`,
        "cache-control": "no-store",
      });
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

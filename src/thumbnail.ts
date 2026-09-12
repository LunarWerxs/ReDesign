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
import * as store from "./store";
import { readJSON } from "./util";
import { INPUT_DIR } from "./inputResolver";
import { resolveChromiumBrowser } from "./portable-window.mjs";
import { isRendererRequestAllowed, rendererDocument } from "./renderer-policy";

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

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>();
  private readonly events = new Set<(message: CdpMessage) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || "Chrome DevTools error"}`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.events) listener(message);
    });
    socket.addEventListener("close", () => this.rejectAll(new Error("Chrome DevTools disconnected")));
    socket.addEventListener("error", () => this.rejectAll(new Error("Chrome DevTools connection failed")));
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Chrome DevTools connection failed")), { once: true });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }

  once(method: string, sessionId?: string): Promise<CdpMessage> {
    return new Promise((resolve) => {
      const listener = (message: CdpMessage) => {
        if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return;
        this.events.delete(listener);
        resolve(message);
      };
      this.events.add(listener);
    });
  }

  on(listener: (message: CdpMessage) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  close(): void { this.socket.close(); }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForDevTools(profileDir: string): Promise<string> {
  const marker = path.join(profileDir, "profile", "DevToolsActivePort");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const [port] = (await fs.promises.readFile(marker, "utf8")).trim().split(/\r?\n/);
      if (port && /^\d+$/.test(port)) {
        const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>);
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
    } catch { /* Chromium has not opened DevTools yet. */ }
    await delay(25);
  }
  throw new Error("Chrome DevTools did not start");
}

async function targetDebuggerUrl(port: number, targetId: string): Promise<string> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json() as Promise<Array<{ id?: string; webSocketDebuggerUrl?: string }>>);
  const target = targets.find((item) => item.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page DevTools target did not start");
  return target.webSocketDebuggerUrl;
}

function safeAssetPath(root: string, rawPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (!decoded || decoded.includes("\0")) return null;
  const candidate = path.resolve(root, decoded);
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? candidate : null;
}

async function startRendererServer(htmlFile: string): Promise<{ origin: string; stop: () => void }> {
  const root = await fs.promises.realpath(path.dirname(htmlFile));
  const html = rendererDocument(await fs.promises.readFile(htmlFile, "utf8"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const headers = {
        // CSP protects DOM execution paths; CDP below protects every browser request, including navigation.
        "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      };
      if (request.method !== "GET") return new Response("Not found", { status: 404, headers });
      if (url.pathname === "/document") return new Response(html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      if (!url.pathname.startsWith("/asset/")) return new Response("Not found", { status: 404, headers });
      const candidate = safeAssetPath(root, url.pathname.slice("/asset/".length));
      if (!candidate) return new Response("Not found", { status: 404, headers });
      try {
        // Resolve symlinks too: lexical containment alone would permit a link out of the run directory.
        const real = await fs.promises.realpath(candidate);
        const relative = path.relative(root, real);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside asset root");
        return new Response(Bun.file(real), { headers });
      } catch {
        return new Response("Not found", { status: 404, headers });
      }
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function stopRenderer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(2_000)]);
  if (child.exitCode === null && child.pid) {
    // This PID belongs to the renderer we just launched. /T also reaps its Chromium children.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  }
}

/** Render an HTML file to a PNG in an isolated headless Chromium renderer. Rejects on failure/timeout. */
export async function renderHtmlToPng(fullHtml: string, outPng: string, size = { width: 1200, height: 900 }): Promise<void> {
  const browser = resolveChromiumBrowser();
  if (!browser) throw new Error("No Edge or Chrome install found to render a preview");
  const profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redesign-thumb-"));
  let child: ReturnType<typeof spawn> | undefined;
  let renderer: { origin: string; stop: () => void } | undefined;
  try {
    await acquireRenderSlot();
    try {
      renderer = await startRendererServer(fullHtml);
      child = spawn(browser.path, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*", `--user-data-dir=${path.join(profileDir, "profile")}`, `--window-size=${size.width},${size.height}`], { stdio: "ignore", windowsHide: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Render timed out")), RENDER_TIMEOUT_MS); });
        await Promise.race([renderWithCdp(child, profileDir, renderer.origin, outPng, size), deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      if (child) await stopRenderer(child);
      renderer?.stop();
      releaseRenderSlot();
    }
  } finally {
    fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderWithCdp(child: ReturnType<typeof spawn>, profileDir: string, origin: string, outPng: string, size: { width: number; height: number }): Promise<void> {
  if (child.exitCode !== null) throw new Error("Renderer exited before DevTools started");
  const browserUrl = await waitForDevTools(profileDir);
  const port = Number(new URL(browserUrl).port);
  const browserCdp = await CdpClient.connect(browserUrl);
  let cdp: CdpClient | undefined;
  try {
    const target = await browserCdp.send("Target.createTarget", { url: "about:blank", newWindow: true, width: size.width, height: size.height });
    const targetId = String(target.targetId);
    await browserCdp.send("Target.activateTarget", { targetId });
    const pageCdp = await CdpClient.connect(await targetDebuggerUrl(port, targetId));
    cdp = pageCdp;
    const unsubscribe = pageCdp.on((event) => {
      if (event.method !== "Fetch.requestPaused") return;
      const params = event.params as { requestId?: string; resourceType?: string; request?: { url?: string } } | undefined;
      const requestId = params?.requestId;
      if (!requestId) return;
      const allowed = isRendererRequestAllowed(params?.request?.url || "", origin);
      const command = allowed ? "Fetch.continueRequest" : "Fetch.failRequest";
      const commandParams = allowed
        ? { requestId }
        : { requestId, errorReason: "BlockedByClient" };
      if (!allowed && params?.resourceType === "Document") void pageCdp.send("Page.stopLoading").catch(() => {});
      void pageCdp.send(command, commandParams).catch(() => {});
    });
    try {
      await pageCdp.send("Page.enable");
      await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      await pageCdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      const loaded = pageCdp.once("Page.loadEventFired");
      await pageCdp.send("Page.navigate", { url: `${origin}/document` });
      await Promise.race([loaded, delay(4_000)]);
      const screenshot = await pageCdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await fs.promises.writeFile(outPng, Buffer.from(String(screenshot.data), "base64"));
    } finally {
      unsubscribe();
      await browserCdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  } finally {
    cdp?.close();
    browserCdp.close();
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
    // Re-read immediately before writing. The caller captured `m` BEFORE a render that can take
    // up to RENDER_TIMEOUT_MS, and runReimagine's 750ms flush writes job results, counts and cost
    // into the same file throughout — spreading the pre-render snapshot would silently discard
    // them. Read the raw JSON rather than store.readManifest so this can't trip the stale-run
    // settling path for a run that is legitimately still going.
    const fresh = readJSON<store.Manifest | null>(store.manifestPath(runId), null) || m;
    store.writeManifest(runId, { ...fresh, thumb: thumbName });
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

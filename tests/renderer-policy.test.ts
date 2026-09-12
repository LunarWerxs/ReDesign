import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRendererRequestAllowed } from "../src/renderer-policy";
import { renderHtmlToPng } from "../src/thumbnail";
import { resolveChromiumBrowser } from "../src/portable-window.mjs";

describe("renderer request policy", () => {
  const origin = "http://127.0.0.1:48123";

  it("permits only the controlled document and explicitly rooted run assets", () => {
    expect(isRendererRequestAllowed(`${origin}/document`, origin)).toBe(true);
    expect(isRendererRequestAllowed(`${origin}/asset/images/logo.png`, origin)).toBe(true);
    expect(isRendererRequestAllowed("data:image/png;base64,AAAA", origin)).toBe(true);
  });

  it("blocks private-network, unrelated local-file, and outbound requests", () => {
    expect(isRendererRequestAllowed("http://127.0.0.1:3000/secrets", origin)).toBe(false);
    expect(isRendererRequestAllowed("http://192.168.1.10/admin", origin)).toBe(false);
    expect(isRendererRequestAllowed("file:///C:/Users/blogi/.ssh/id_rsa", origin)).toBe(false);
    expect(isRendererRequestAllowed("https://example.test/tracker.js", origin)).toBe(false);
    expect(isRendererRequestAllowed(`${origin}/api/anything`, origin)).toBe(false);
  });
});

describe("isolated Chromium renderer", () => {
  const cleanup: string[] = [];
  afterAll(() => { cleanup.forEach((file) => { fs.rmSync(file, { recursive: true, force: true }); }); });

  it("does not contact a private loopback trap through resources, fetches, or navigation", async () => {
    if (!resolveChromiumBrowser()) return;
    let hits = 0;
    const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("trap"); } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-renderer-policy-"));
    cleanup.push(dir);
    const target = `http://127.0.0.1:${trap.port}/private`;
    const html = path.join(dir, "preview.html");
    const png = path.join(dir, "preview.png");
    fs.writeFileSync(html, `<!doctype html><img src="${target}"><script src="${target}"></script><script>fetch(${JSON.stringify(target)}).catch(()=>{}); location.href=${JSON.stringify(target)};</script>`);
    try {
      await renderHtmlToPng(html, png, { width: 320, height: 180 });
      expect(fs.existsSync(png)).toBe(true);
      expect(fs.statSync(png).size).toBeGreaterThan(100);
      expect(hits).toBe(0);
    } finally {
      trap.stop(true);
    }
  }, 40_000);
});

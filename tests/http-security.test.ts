import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/http/app";
import { serveFile, serveOutputWrapper } from "../src/http/fileServing";
import { loadModels } from "../src/config";
import { register as registerModels } from "../src/http/routes/models";
import { _resetCacheForTests as clearCatalogCache } from "../src/modelCatalog";

const app = createApp();
const origin = "http://127.0.0.1:5178";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "redesign-public-files-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("HTTP browser provenance", () => {
  it("rejects a foreign localhost page and its Origin-less subresource requests", async () => {
    const cases: Record<string, string>[] = [
      { Origin: "http://127.0.0.1:9999", "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of cases) {
      const res = await app.request(`${origin}/api/health`, { headers });
      expect(res.status).toBe(403);
    }
  });

  it("accepts the actual request origin after port hopping and intentional Vite origins", async () => {
    const cases: Record<string, string>[] = [
      { Origin: "http://127.0.0.1:5280", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "same-origin" },
      { Origin: "http://localhost:5173", "Sec-Fetch-Site": "same-site" },
      {}, // CLI/MCP/tray clients do not send browser provenance headers.
    ];
    for (const headers of cases) {
      const res = await app.request("http://127.0.0.1:5280/api/health", { headers });
      expect(res.status).toBe(200);
    }
  });

  it("checks Host before static files, OAuth and the SPA fallback", async () => {
    for (const route of ["/input/missing.png", "/reference/missing.png", "/output/a.html", "/output-raw/a.json", "/oauth/callback", "/viewer"]) {
      const res = await app.request(`${origin}${route}`, { headers: { Host: "audit.invalid", "Sec-Fetch-Site": "same-origin" } });
      expect(res.status).toBe(403);
    }
  });

  it("allows a legitimate cross-site OAuth return with a local Host", async () => {
    const res = await app.request(`${origin}/oauth/callback`, { headers: { Host: "127.0.0.1:5178", "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?connect=failed");
  });
});

describe("public file boundaries", () => {
  const files = new Hono();
  files.get("/*", (c) => serveFile(c, scratch, new URL(c.req.url).pathname.slice(1)));
  fs.mkdirSync(path.join(scratch, "run", ".private"), { recursive: true });
  fs.writeFileSync(path.join(scratch, ".reimagine-connections.json"), '{"sdk":"fake-session"}');
  fs.writeFileSync(path.join(scratch, "run", ".private", "secret.json"), "fake-secret");
  fs.writeFileSync(path.join(scratch, "run", "design.meta.json"), '{"job":"public-metadata"}');

  it("refuses private files even when the name or separator is URL-encoded", async () => {
    for (const rel of [".reimagine-connections.json", "%2ereimagine-connections.json", "run/.private/secret.json", "run%2f.private%2fsecret.json"]) {
      const res = await files.request(`http://localhost/${rel}`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("fake-session");
    }
  });

  it("still serves public run metadata", async () => {
    const res = await files.request("/run/design.meta.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: "public-metadata" });
  });

  it("applies the private-path rule before rendering an output wrapper", async () => {
    const wrappers = new Hono();
    wrappers.get("/*", (c) => serveOutputWrapper(c, ".private/design.html"));
    expect((await wrappers.request("/test")).status).toBe(403);
  });
});

describe("model catalog credential binding", () => {
  const models = new Hono();
  registerModels(models, { requestShutdown: () => {} });

  async function lookup(query: string) {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization: string | null }> = [];
    clearCatalogCache();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-model" }], models: [{ name: "models/fixture-model", supportedGenerationMethods: ["generateContent"] }] });
    }) as typeof fetch;
    try {
      const response = await models.request(`/api/models/available?${query}`);
      return { response, calls };
    } finally {
      globalThis.fetch = originalFetch;
      clearCatalogCache();
    }
  }

  it("refuses an arbitrary destination before reading or forwarding its requested key pool", async () => {
    const { response, calls } = await lookup("provider=openai&baseUrl=https://audit.invalid/v1&keyEnv=ANTHROPIC_API_KEYS");
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("catalog_binding_required");
    expect(calls).toEqual([]);
  });

  it("refuses borrowing another provider's pool even at a default endpoint", async () => {
    const { response, calls } = await lookup("provider=openai&keyEnv=ANTHROPIC_API_KEYS");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("allows a default provider binding", async () => {
    const { response, calls } = await lookup("provider=openai");
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.authorization).toBe("Bearer sk-proj-o1");
  });

  it("allows an explicitly configured model binding with a nondefault key pool", async () => {
    const configured = loadModels().find((m) => m.keyEnv === "GEMINI_FLASH_API_KEYS");
    expect(configured).toBeDefined();
    const query = new URLSearchParams({ provider: configured!.provider, baseUrl: configured!.baseUrl, keyEnv: configured!.keyEnv });
    const { response, calls } = await lookup(query.toString());
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toStartWith(configured!.baseUrl);
  });
});

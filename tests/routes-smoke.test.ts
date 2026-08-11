// Request-level smoke coverage for route modules that previously had none, plus the new
// jsonBodyLimit() wiring in src/http/app.ts. Builds the real Hono app via createApp()
// (src/http/app.ts) and dispatches through Hono's own in-process app.request() helper (the same
// one tests/prompt-builder-options.test.ts uses) — no real server socket, no port, no browser.
//
// A couple of these routes would otherwise reach out for real:
//   - GET /api/updates calls src/updater.ts's checkForUpdate(), which (unpackaged, exactly how
//     tests run) shells out to `git ls-remote` against this repo's REAL GitHub remote
//     (src/updater-engine.mjs) — a genuine network call with no MOCK=1 gate. So this file mocks
//     src/updater.ts's checkForUpdate/applyUpdate before importing the app, reusing the
//     bun:test mock.module technique from tests/settings.test.ts (see that file's header for why
//     a plain-object snapshot, not the live namespace, is what makes the afterAll restore work).
//   - POST /api/updates/apply is never sent a *passing* Origin here — a real apply runs
//     `npm install`/`npm run build` against the live checkout. Only the guard-rejection path is
//     exercised.
//   - POST /api/health-check pings every active model's real provider API with no MOCK gate
//     (src/healthCheck.ts). Only the guard-rejection path is exercised.
//   - The Connections OAuth callback is only driven with code/state OMITTED, which short-circuits
//     to `ok=false` before src/connections.ts ever calls the real token endpoint. A real
//     code/state pair would need src/connections.ts's own network-mocking machinery
//     (tests/connections.test.ts already covers that surface in full against a fake server).
import { afterAll, describe, expect, it, mock } from "bun:test";
import type { UpdateStatus } from "../src/updater-engine.mjs";

const realUpdaterLive = await import("../src/updater");
const realUpdaterSnapshot = { ...realUpdaterLive }; // decoupled plain-object copy, not the live namespace

const FAKE_UPDATE_STATUS: UpdateStatus = {
  ok: true,
  service: "redesign",
  currentVersion: "0.0.0-test",
  currentCommit: "aaaaaaa",
  remoteCommit: "aaaaaaa",
  branch: "main",
  upstream: "origin/main",
  remote: "origin",
  dirty: false,
  updateAvailable: false,
  canApply: false,
  checkedAt: 0,
  reason: null,
};

mock.module("../src/updater", () => ({
  ...realUpdaterSnapshot,
  checkForUpdate: async () => FAKE_UPDATE_STATUS,
  applyUpdate: async () => {
    throw new Error("applyUpdate must not be invoked by a smoke test");
  },
}));

afterAll(() => {
  mock.module("../src/updater", () => realUpdaterSnapshot);
});

const { createApp } = await import("../src/http/app");
const app = createApp();

// A non-loopback Origin trips loopbackGuard's "non-loopback Origin rejected" branch regardless of
// Sec-Fetch-Site (see src/loopback-guard.mjs), the same guard every mutating /api route wraps.
const CROSS_SITE_HEADERS = { Origin: "https://evil.example.com" };

describe("routes/updates.ts", () => {
  it("GET /api/updates returns the updater's status untouched (no real git/network call)", async () => {
    const res = await app.request("/api/updates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UpdateStatus;
    expect(body).toEqual(FAKE_UPDATE_STATUS);
  });

  it("POST /api/updates/apply rejects a cross-site request before running anything", async () => {
    const res = await app.request("/api/updates/apply", { method: "POST", headers: CROSS_SITE_HEADERS });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/forbidden/i);
  });
});

describe("routes/connections.ts", () => {
  it("GET /api/auth/me returns the identity shape", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.connected).toBe("boolean");
  });

  it("GET /api/settings/sync returns the sync-status shape", async () => {
    const res = await app.request("/api/settings/sync");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.enabled).toBe("boolean");
    expect(typeof body.version).toBe("number");
  });

  it("PUT /api/settings/sync with an empty body only echoes status (no enable/disable, no network)", async () => {
    const res = await app.request("/api/settings/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("GET /oauth/callback without code/state redirects to the failure page without calling the token endpoint", async () => {
    const res = await app.request("/oauth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?connect=failed");
  });
});

describe("routes/settings.ts", () => {
  it("GET /api/settings exposes updateNotify alongside autoUpdate", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.autoUpdate).toBe("boolean");
    expect(typeof body.updateNotify).toBe("boolean");
  });

  it("PUT /api/settings toggles updateNotify independently of autoUpdate", async () => {
    const before = (await (await app.request("/api/settings")).json()) as Record<string, unknown>;
    try {
      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateNotify: !before.updateNotify }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.updateNotify).toBe(!before.updateNotify);
      // Untouched by a PUT that only names updateNotify.
      expect(body.autoUpdate).toBe(before.autoUpdate);
    } finally {
      // Restore, this writes the real output/.reimagine-settings.json.
      await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updateNotify: before.updateNotify }),
      });
    }
  });
});

describe("routes/health.ts", () => {
  it("GET /api/health returns a sane liveness shape", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("redesign");
    expect(typeof body.ts).toBe("number");
  });

  it("POST /api/health-check rejects a cross-site request before pinging any provider", async () => {
    const res = await app.request("/api/health-check", { method: "POST", headers: CROSS_SITE_HEADERS });
    expect(res.status).toBe(403);
  });
});

describe("routes/output.ts", () => {
  it("GET /output-raw/* rejects an encoded path-traversal attempt", async () => {
    // %2f keeps the "/" encoded so Hono's URL parsing never collapses the ".." segments before
    // src/util.ts's resolveInside() decodes and rejects them (the same encoded-traversal shape
    // tests/store.test.ts's "GET /api/runs/:id" case uses).
    const res = await app.request("/output-raw/..%2f..%2fpackage.json");
    expect(res.status).not.toBe(200);
    expect([400, 403]).toContain(res.status);
  });

  it("GET /output/*.html rejects an encoded path-traversal attempt (serveOutputWrapper)", async () => {
    const res = await app.request("/output/..%2f..%2fpackage.json.html");
    expect(res.status).not.toBe(200);
    expect([400, 403]).toContain(res.status);
  });

  it("GET /output-raw/* for an ordinary missing file 404s rather than 403ing", async () => {
    const res = await app.request("/output-raw/definitely-does-not-exist.png");
    expect(res.status).toBe(404);
  });

  it("POST /api/output/open rejects a cross-site request before touching the filesystem", async () => {
    const res = await app.request("/api/output/open", { method: "POST", headers: CROSS_SITE_HEADERS });
    expect(res.status).toBe(403);
  });

  it("GET /api/output/screenshot rejects a cross-site request before spawning a renderer", async () => {
    const res = await app.request("/api/output/screenshot", { headers: CROSS_SITE_HEADERS });
    expect(res.status).toBe(403);
  });
});

describe("jsonBodyLimit: default 5 MB cap vs. the two upload routes' larger cap", () => {
  it("an oversized JSON body to an ordinary /api route is rejected with 413", async () => {
    const oversized = "x".repeat(6 * 1024 * 1024); // ~6 MB, over the 5 MB default (src/http/body-limit.ts)
    const res = await app.request("/api/inputs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: oversized }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("body too large");
  });

  it("the same size body is accepted (not 413'd) by the upload route's larger cap", async () => {
    // Base64 alphabet characters, so it decodes to a real ~4.5 MB buffer (under the 20 MB
    // per-image cap) but not real PNG bytes: it clears the 40 MB body-limit exemption
    // (src/http/app.ts's OWN_BODY_LIMIT_PATHS) and the per-image size check, then fails
    // imageMagicMatches() in src/inputResolver.ts BEFORE any fs.writeFileSync — proving the
    // route accepted the oversized BODY without ever writing a file into the repo's real
    // input/ directory (the route always uses the default INPUT_DIR; only the underlying
    // saveUploadedImages() function itself takes an inputDir override, and the route never
    // passes one).
    const bogusImageData = "A".repeat(6 * 1024 * 1024);
    const res = await app.request("/api/inputs/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [{ name: "big.png", mime: "image/png", data: bogusImageData }] }),
    });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
  });
});

/**
 * Tests for src/connections.ts, the daemon-side BFF for "Sync my settings with Connections".
 *
 * Zero prior coverage for this surface, so this file exercises the whole lifecycle against a
 * MOCKED fetch (OIDC discovery + token endpoint + the locker's studio.connections.icu calls), 
 * NEVER the real Connections service. Modeled on RepoYeti's tests/connections-sync.test.ts, but
 * Reimagine's module is simpler: no config object is threaded through (state lives in the
 * module + a state file on disk) and the only synced field is `appearance` (theme), there is no
 * PREF_KEYS allowlist to test here since nothing else is ever sent.
 *
 * Covers:
 *  - PKCE login URL shape (buildAuthorizeUrl)
 *  - token exchange (handleCallback) + refresh-on-expired/missing access token
 *  - refresh-token rotation persisted to the 0600 state file
 *  - a dead/revoked refresh token (400/401) clears the connection
 *  - enable/disable/forget lifecycle
 *  - push/pull appearance merge
 *  - malformed remote appearance blob ignored
 */
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/util";
import * as conn from "../src/connections";
import { unseal, sealingActive } from "../src/dpapi-seal.mjs";

const STATE_FILE = path.join(ROOT, "output", ".reimagine-connections.json");

const ISSUER = "https://accounts.connections.icu";
const CLIENT_ID = "61c299a8207889e59d3a43faaf9b6524"; // must match src/connections.ts's OAUTH.clientId
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const USERINFO_ENDPOINT = `${ISSUER}/oauth/userinfo`;
const STORE_BASE = "https://studio.connections.icu";
const DOC_URL = `${STORE_BASE}/v1/app-data/${encodeURIComponent(CLIENT_ID)}`;

/** In-memory fake of the remote app-data document + OIDC token/userinfo endpoints, wired as the
 *  global fetch. Never talks to the real Connections service. */
class FakeConnectionsServer {
  version = 0;
  settings: Record<string, unknown> = {};
  validRefreshTokens = new Set<string>(["initial-refresh-token"]);
  rotateTo: string | null = null;
  /** expires_in returned for the authorization_code exchange (tests can force -1 to make the
   *  code-exchange access token look already-expired, so the very next call must refresh). */
  codeExchangeExpiresIn = 3600;
  refreshExpiresIn = 3600;
  tokenCalls = 0;
  docGetCalls = 0;
  docPostCalls = 0;
  docDeleteCalls = 0;
  lastAuthHeader: string | null = null;

  fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZE_URL,
          token_endpoint: TOKEN_ENDPOINT,
          userinfo_endpoint: USERINFO_ENDPOINT,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === TOKEN_ENDPOINT && method === "POST") {
      this.tokenCalls += 1;
      const body = new URLSearchParams(String(init?.body ?? ""));
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        const code = body.get("code");
        if (code !== "good-code") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: "access-from-code",
            refresh_token: "initial-refresh-token",
            expires_in: this.codeExchangeExpiresIn,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // refresh_token grant
      const rt = body.get("refresh_token");
      if (!rt || !this.validRefreshTokens.has(rt)) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      const payload: Record<string, unknown> = { access_token: `access-for-${rt}`, expires_in: this.refreshExpiresIn };
      if (this.rotateTo) {
        payload.refresh_token = this.rotateTo;
        this.validRefreshTokens.add(this.rotateTo);
        this.rotateTo = null;
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url === USERINFO_ENDPOINT) {
      return new Response(JSON.stringify({ sub: "user-123", email: "owner@example.com", name: "Owner Example" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === DOC_URL) {
      this.lastAuthHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      if (method === "GET") {
        this.docGetCalls += 1;
        return new Response(
          JSON.stringify({
            app_id: CLIENT_ID,
            settings: this.settings,
            server_settings: {},
            version: this.version,
            updated_at: this.version ? new Date().toISOString() : null,
            bytes_used: 0,
            max_bytes: 65536,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST") {
        this.docPostCalls += 1;
        const req = JSON.parse(String(init?.body ?? "{}")) as {
          settings: Record<string, unknown>;
          baseVersion: number;
          merge?: boolean;
        };
        if (req.baseVersion !== this.version) {
          return new Response(
            JSON.stringify({ error: "version_conflict", current: { settings: this.settings, version: this.version } }),
            { status: 409 },
          );
        }
        if (req.merge) this.settings = { ...this.settings, ...req.settings };
        else this.settings = req.settings;
        this.version += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (method === "DELETE") {
        this.docDeleteCalls += 1;
        this.settings = {};
        this.version = 0;
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`[test] unexpected fetch to ${method} ${url}, seam leak`);
  };
}

let server: FakeConnectionsServer;
let origFetch: typeof fetch;
let preExistingState: string | null = null;

beforeEach(async () => {
  server = new FakeConnectionsServer();
  origFetch = globalThis.fetch;
  globalThis.fetch = server.fetchImpl as unknown as typeof fetch;
  // Save + remove any real state file so each test starts from a clean slate, then re-init the
  // module against that clean disk state (initConnections() is a one-shot "loaded" guard, so we
  // rely on disable({forget:true}) between tests instead of re-importing the module fresh).
  try {
    preExistingState = fs.readFileSync(STATE_FILE, "utf8");
  } catch (_) {
    preExistingState = null;
  }
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch (_) {
    /* ignore */
  }
  // Fully reset in-module state between tests (forget wipes refreshToken/appearance/version/etc).
  await conn.disable(true);
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await conn.disable(true);
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch (_) {
    /* ignore */
  }
});

afterAll(() => {
  // Restore whatever was on disk before this suite ran (if anything).
  try {
    if (preExistingState !== null) {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, preExistingState, { mode: 0o600 });
    } else {
      fs.rmSync(STATE_FILE, { force: true });
    }
  } catch (_) {
    /* best-effort */
  }
});

// ── PKCE login URL shape ────────────────────────────────────────────────────────────────

test("buildAuthorizeUrl produces a PKCE authorize URL with the expected fixed shape", async () => {
  const url = new URL(await conn.buildAuthorizeUrl("http://127.0.0.1:5178"));
  expect(url.origin).toBe(new URL(AUTHORIZE_URL).origin);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5178/oauth/callback");
  expect(url.searchParams.get("scope")).toBe("openid profile email photo");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("state")).toBeTruthy();
});

// ── token exchange + refresh-on-expired/missing access token ────────────────────────────

test("handleCallback exchanges the code, stores the refresh token, and fetches identity", async () => {
  const authUrl = new URL(await conn.buildAuthorizeUrl("http://127.0.0.1:5178"));
  const stateTok = authUrl.searchParams.get("state")!;
  const ok = await conn.handleCallback("http://127.0.0.1:5178", "good-code", stateTok);
  expect(ok).toBe(true);
  expect(conn.hasConnection()).toBe(true);
  const status = conn.syncStatus();
  expect(status.connected).toBe(true);
  expect(status.email).toBe("owner@example.com");
  // Persisted to disk 0600 — the credential now lives inside the SDK's token entry, DPAPI-sealed
  // at rest on Windows (opaque, DPAPIv1-marked) and plaintext passthrough elsewhere.
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const storedToken = JSON.parse(raw).sdk[`cnx.connect.tokens.${CLIENT_ID}`];
  if (sealingActive()) expect(storedToken.startsWith("DPAPIv1:")).toBe(true);
  const sdkTokens = JSON.parse(unseal(storedToken)!);
  expect(sdkTokens.refreshToken).toBe("initial-refresh-token");
  const mode = fs.statSync(STATE_FILE).mode & 0o777;
  if (process.platform !== "win32") expect(mode).toBe(0o600);
});

test("handleCallback rejects an unknown/expired state token", async () => {
  const ok = await conn.handleCallback("http://127.0.0.1:5178", "good-code", "not-a-real-state-token");
  expect(ok).toBe(false);
  expect(conn.hasConnection()).toBe(false);
});

test("handleCallback returns false when the code exchange fails", async () => {
  const authUrl = new URL(await conn.buildAuthorizeUrl("http://127.0.0.1:5178"));
  const stateTok = authUrl.searchParams.get("state")!;
  const ok = await conn.handleCallback("http://127.0.0.1:5178", "bad-code", stateTok);
  expect(ok).toBe(false);
  expect(conn.hasConnection()).toBe(false);
});

async function signIn(): Promise<void> {
  const authUrl = new URL(await conn.buildAuthorizeUrl("http://127.0.0.1:5178"));
  const stateTok = authUrl.searchParams.get("state")!;
  const ok = await conn.handleCallback("http://127.0.0.1:5178", "good-code", stateTok);
  if (!ok) throw new Error("test setup: signIn failed");
}

test("pushNow reuses the access token handleCallback already cached, no refresh call", async () => {
  await signIn(); // code exchange returns a fresh, unexpired access token (expires_in: 3600)
  server.tokenCalls = 0; // reset the counter after the callback's own token exchange
  await conn.pushNow();
  expect(server.tokenCalls).toBe(0); // still-valid cached token, no refresh needed
  expect(server.lastAuthHeader).toBe("Bearer access-from-code");
});

test("an expired code-exchange access token triggers a refresh before any store call", async () => {
  server.codeExchangeExpiresIn = -1; // the code-exchange token looks already-expired
  await signIn();
  // Under the SDK the refresh happens IMMEDIATELY — handleCallback's own identity fetch
  // (getUser → getAccessToken) sees the expired token and refreshes before userinfo. So the
  // callback costs exchange + refresh, and the locker call then rides the refreshed token.
  expect(server.tokenCalls).toBe(2);
  server.tokenCalls = 0;
  await conn.pushNow(); // the refreshed token is still fresh — no additional refresh
  expect(server.tokenCalls).toBe(0);
  expect(server.lastAuthHeader).toBe("Bearer access-for-initial-refresh-token");
});

test("a second pushNow within the refreshed token's lifetime reuses the cached access token", async () => {
  server.codeExchangeExpiresIn = -1;
  await signIn();
  await conn.pushNow(); // primes a fresh cached access token via refresh (expires_in: 3600)
  const callsAfterFirst = server.tokenCalls;
  await conn.pushNow();
  expect(server.tokenCalls).toBe(callsAfterFirst); // no additional refresh call
});

// ── refresh-token rotation ───────────────────────────────────────────────────────────────

test("a rotated refresh_token from the IdP is persisted and used on the next refresh", async () => {
  server.codeExchangeExpiresIn = -1; // force a refresh during the callback's identity fetch
  server.rotateTo = "rotated-refresh-token"; // that refresh ROTATES the refresh token
  await signIn();

  const readSdkTokens = () =>
    JSON.parse(unseal(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).sdk[`cnx.connect.tokens.${CLIENT_ID}`])!);
  expect(readSdkTokens().refreshToken).toBe("rotated-refresh-token");
  expect(server.lastAuthHeader).toBeNull(); // no store call yet — rotation happened at sign-in

  // The freshly-refreshed access token (expires_in: 3600) is cached; confirm the ROTATED refresh
  // token stays durably on file across store calls that reuse the cached access token.
  await conn.pushNow();
  expect(server.lastAuthHeader).toBe("Bearer access-for-initial-refresh-token"); // the refresh's own token
  await conn.pullNow();
  expect(readSdkTokens().refreshToken).toBe("rotated-refresh-token"); // rotation persisted, still there
});

test("a dead/revoked refresh token (400) clears the stored connection entirely", async () => {
  // Every minted access token looks already-expired (both knobs -1), so pushNow MUST go through
  // a refresh — the real path a stale/revoked refresh token is caught on, exactly as it would
  // after the daemon restarts with only a refresh token persisted.
  server.codeExchangeExpiresIn = -1;
  server.refreshExpiresIn = -1;
  await signIn();
  expect(conn.hasConnection()).toBe(true);
  // Now make the fake IdP reject the refresh token (revoked/expired server-side).
  server.validRefreshTokens.delete("initial-refresh-token");

  await expect(conn.pushNow()).rejects.toThrow();
  expect(conn.hasConnection()).toBe(false); // the SDK cleared the dead session on invalid_grant
  const onDisk = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  expect(onDisk.sdk?.[`cnx.connect.tokens.${CLIENT_ID}`]).toBeUndefined();
});

test("pushNow rejects with not_signed_in when there is no connection at all", async () => {
  await expect(conn.pushNow()).rejects.toThrow();
  expect(conn.hasConnection()).toBe(false);
});

// ── enable/disable/forget lifecycle ───────────────────────────────────────────────────────

test("enable() with an empty remote doc seeds the store with local appearance", async () => {
  await signIn();
  const result = await conn.enable({ theme: "dark" });
  expect(result.status.enabled).toBe(true);
  expect(result.status.connected).toBe(true);
  expect(server.docPostCalls).toBe(1); // seeded (pushed), not pulled-and-applied
  expect(server.settings.appearance).toEqual({ theme: "dark" });
});

test("enable() with a populated remote doc pulls and applies it locally instead of pushing", async () => {
  await signIn();
  server.settings = { appearance: { theme: "light" } };
  server.version = 1;

  const result = await conn.enable({ theme: "dark" });
  expect(result.status.enabled).toBe(true);
  expect(server.docPostCalls).toBe(0); // never pushed, only pulled
  expect(result.status.appearance).toEqual({ theme: "light" }); // applied from remote, not local
});

test("enable() while signed out turns the flag on locally but performs no network call", async () => {
  const result = await conn.enable({ theme: "dark" });
  expect(result.status.enabled).toBe(true);
  expect(result.status.connected).toBe(false);
  expect(server.docGetCalls + server.docPostCalls).toBe(0);
});

test("disable() without forget turns sync off but keeps the connection + remote doc", async () => {
  await signIn();
  await conn.enable({ theme: "dark" });
  const status = await conn.disable(false);
  expect(status.enabled).toBe(false);
  expect(conn.hasConnection()).toBe(true); // still connected
  expect(server.docDeleteCalls).toBe(0);
});

test("disable({forget: true}) deletes the remote doc and clears local tokens/state", async () => {
  await signIn();
  await conn.enable({ theme: "dark" });
  const status = await conn.disable(true);
  expect(status.enabled).toBe(false);
  expect(server.docDeleteCalls).toBe(1);
  expect(conn.hasConnection()).toBe(false);
  expect(status.appearance).toBeNull();
  expect(status.version).toBe(0);
});

test("disable({forget: true}) still clears local state even if the remote delete fails", async () => {
  await signIn();
  await conn.enable({ theme: "dark" });
  const realImpl = server.fetchImpl;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
      return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
    }
    return realImpl(input, init);
  }) as unknown as typeof fetch;

  const status = await conn.disable(true);
  expect(status.enabled).toBe(false);
  expect(conn.hasConnection()).toBe(false); // local disconnect proceeds regardless
});

// ── push/pull appearance merge ───────────────────────────────────────────────────────────

test("pushNow sends the locally-held appearance blob (deep-merge)", async () => {
  await signIn();
  await conn.updateAppearance({ theme: "dark" }); // enabled=false here, so no auto-push
  await conn.pushNow();
  expect(server.settings.appearance).toEqual({ theme: "dark" });
});

test("pullNow adopts a remote appearance blob (object)", async () => {
  await signIn();
  server.settings = { appearance: { theme: "light" } };
  server.version = 1;
  const result = await conn.pullNow();
  expect(result.version).toBe(1);
  expect(conn.syncStatus().appearance).toEqual({ theme: "light" });
});

test("pullNow against a never-written remote doc (version 0) applies nothing", async () => {
  await signIn();
  const before = conn.syncStatus().appearance;
  const result = await conn.pullNow();
  expect(result.version).toBe(0);
  expect(conn.syncStatus().appearance).toEqual(before);
});

test("pullNow ignores a malformed (non-object) remote appearance value", async () => {
  await signIn();
  await conn.updateAppearance({ theme: "dark" });
  server.settings = { appearance: "not-an-object" as unknown as Record<string, unknown> };
  server.version = 1;
  await conn.pullNow();
  expect(conn.syncStatus().appearance).toEqual({ theme: "dark" }); // left untouched
});

test("updateAppearance pushes only when sync is enabled + connected", async () => {
  await signIn();
  // Disabled: recorded locally, no network call.
  await conn.updateAppearance({ theme: "light" });
  expect(conn.syncStatus().appearance).toEqual({ theme: "light" });
  expect(server.docPostCalls).toBe(0);

  // Enabled + connected: recorded locally AND pushed.
  await conn.enable(); // flips enabled=true; remote is empty version 0 -> seeds with current appearance
  const postsAfterEnable = server.docPostCalls;
  await conn.updateAppearance({ theme: "system" });
  expect(conn.syncStatus().appearance).toEqual({ theme: "system" });
  expect(server.docPostCalls).toBe(postsAfterEnable + 1);
  expect(server.settings.appearance).toEqual({ theme: "system" });
});

// ── syncStatus() projection ────────────────────────────────────────────────────────────

test("syncStatus reflects enabled/connected/version/appearance from module state", async () => {
  expect(conn.hasConnection()).toBe(false);
  let s = conn.syncStatus();
  expect(s).toEqual({ enabled: false, connected: false, name: null, email: null, picture: null, lastSyncedAt: null, version: 0, appearance: null });

  await signIn();
  s = conn.syncStatus();
  expect(s.connected).toBe(true);
  expect(s.name).toBe("Owner Example"); // display name from userinfo (profile scope), preferred over the relay email
  expect(s.email).toBe("owner@example.com");
});

// ── logout() ─────────────────────────────────────────────────────────────────────────────

test("logout() fully disconnects (equivalent to disable({forget: true}))", async () => {
  await signIn();
  await conn.enable({ theme: "dark" });
  await conn.logout();
  expect(conn.hasConnection()).toBe(false);
  expect(conn.syncStatus().enabled).toBe(false);
  expect(server.docDeleteCalls).toBe(1);
});

// ---------------------------------------------------------------------------
// "Sync my settings with Connections", the daemon-side Backend-for-Frontend.
//
// Reimagine is a single-user local daemon, so the daemon IS the BFF: it runs the
// OIDC login (Authorization Code + PKCE, public client, no secret), holds the
// owner's refresh token server-side, mints access tokens, and calls the Connections
// settings-sync store (studio.connections.icu/v1/app-data/{clientId}). The browser
// never holds a token.
//
// Since 2026-07-08 the OAuth/refresh/identity machinery is the OFFICIAL SDK — @cnct/connect
// (the settings-sync store ships from the same package) — instead of a hand-rolled copy:
// single-flight rotation-safe refresh, per-attempt redirect_uri, server-side revoke on forget,
// and id_token identity all come from the shared package. This module keeps only the
// Reimagine-specific parts: the state file, the appearance blob, and the sync orchestration.
//
// What syncs: Reimagine's only portable per-user preference is its APPEARANCE (theme),
// its other "settings" are model/prompt CONTENT and secret API keys, which must never
// sync. So the synced document is { appearance: { theme } }, supplied + applied by the
// web. This still makes Reimagine part of the constellation: the same Connections
// account carries the same theme across every LunarWerx app.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import {
  createConnect,
  createSettingsSync,
  type ConnectClient,
  type ConnectStore,
  type SettingsSync,
  type SettingsSyncStatus,
  type TokenSet,
} from "@cnct/connect";
import { applySyncedPrefs, readSyncedPrefs } from "./app-settings";
import { seal, unseal, wrapTokenStore } from "./dpapi-seal.mjs";
import { ROOT } from "./util";

/** Reimagine's own public "Sign in with Connections" OAuth client (PKCE, no secret). Its client_id
 *  doubles as the settings-sync store appId, namespacing Reimagine's synced data to itself. */
const OAUTH = {
  issuer: "https://accounts.connections.icu",
  clientId: "61c299a8207889e59d3a43faaf9b6524",
  scopes: ["openid", "profile", "email", "photo"],
};

// Per-user state (SDK session + sync state), 0600, alongside the pulse state under output/.
const STATE_FILE = path.join(ROOT, "output", ".reimagine-connections.json");

interface Identity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

interface ConnectionsState {
  /** LEGACY (pre-SDK) credential slot — migrated into `sdk` on first load, then removed. */
  refreshToken?: string;
  enabled?: boolean;
  lastSyncedAt?: string;
  version?: number;
  appearance?: Record<string, unknown> | null;
  identity?: Identity;
  /** The @cnct/connect session entries (token set + in-flight PKCE), keyed by the SDK. */
  sdk?: Record<string, string>;
}

let state: ConnectionsState = {};
let loaded = false;

function persist(): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* best-effort temp cleanup */
    }
    throw e;
  }
}

// The SDK's persistence rides THIS module's state file (one 0600 JSON for everything), via a
// ConnectStore adapter over the in-memory `state` — every set/remove goes through persist().
const TOKEN_KEY = `cnx.connect.tokens.${OAUTH.clientId}`;
const stateStore: ConnectStore = {
  get: (key) => state.sdk?.[key] ?? null,
  set: (key, value) => {
    state.sdk ??= {};
    state.sdk[key] = value;
    persist();
  },
  remove: (key) => {
    if (state.sdk && key in state.sdk) {
      delete state.sdk[key];
      persist();
    }
  },
};

let connectClient: ConnectClient | null = null;
/** The lazily-built SDK client. Constructor redirectUri is a placeholder — every real sign-in
 *  passes the live origin per attempt. fetch is late-bound so the test harness's globalThis.fetch
 *  stub is honored (the SDK captures `fetch` at construction; the client is memoized). */
function connect(): ConnectClient {
  connectClient ??= createConnect({
    clientId: OAUTH.clientId,
    issuer: OAUTH.issuer,
    scopes: OAUTH.scopes,
    redirectUri: "http://127.0.0.1/oauth/callback",
    // Wrap the store so the persisted TokenSet (the durable refresh token) is DPAPI-sealed at
    // rest on Windows; the transient PKCE record and non-Windows hosts pass through unchanged.
    store: wrapTokenStore(stateStore, TOKEN_KEY),
    fetch: ((...args: Parameters<typeof fetch>) =>
      globalThis.fetch(...args)) as typeof fetch,
  });
  return connectClient;
}

/** Load persisted sync state (incl. the credential) into memory. Call once at boot. */
function initConnections(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STATE_FILE))
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    state = {};
  }
  // One-time legacy migration (pre-SDK state files): the bare refreshToken moves into the SDK's
  // token entry in the SAME file, so an existing signed-in daemon stays signed in across the
  // upgrade — no re-login. expiresAt 0 forces a refresh on first use (rotation persists back
  // through the store adapter above).
  if (state.refreshToken && !state.sdk?.[TOKEN_KEY]) {
    const seed: TokenSet = {
      accessToken: "",
      refreshToken: state.refreshToken,
      expiresAt: 0,
    };
    state.sdk ??= {};
    state.sdk[TOKEN_KEY] = seal(JSON.stringify(seed)); // seal the seeded token at rest (Windows)
    delete state.refreshToken;
    persist();
  }
}

/** True when the daemon holds a Connections credential (the owner has signed in). */
function hasConnection(): boolean {
  const raw = state.sdk?.[TOKEN_KEY];
  if (!raw) return false;
  const plain = unseal(raw); // DPAPI-sealed at rest → decrypt; legacy plaintext passes through
  if (!plain) return false;
  try {
    const tokens = JSON.parse(plain) as TokenSet;
    return Boolean(tokens.refreshToken || tokens.accessToken);
  } catch (_) {
    return false;
  }
}

/** Build the authorize URL for a sign-in that redirects back to `${origin}/oauth/callback`.
 *  The live origin rides the SDK's per-attempt redirectUri override. */
async function buildAuthorizeUrl(origin: string): Promise<string> {
  return connect().signIn({
    redirect: false,
    redirectUri: `${origin}/oauth/callback`,
  });
}

/** Complete the OIDC callback: exchange the code, persist the session, capture identity. */
async function handleCallback(
  origin: string,
  code: string,
  stateTok: string,
): Promise<boolean> {
  try {
    const callbackUrl = `${origin}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateTok)}`;
    const user = await connect().handleCallback(callbackUrl);
    state.identity = {
      sub: user.sub,
      email: user.email || "",
      name: user.name || "",
      picture: user.picture || "",
    };
    persist();
    return true;
  } catch (_) {
    return false;
  }
}

/** Backfill display identity (name/picture) for sessions created before those fields existed —
 *  best-effort, only when something is missing, piggybacking on calls that already network. */
async function backfillIdentity(): Promise<void> {
  if (state.identity?.name && state.identity?.picture) return;
  try {
    const user = await connect().getUser();
    state.identity = {
      sub: user.sub,
      email: user.email || "",
      name: user.name || "",
      picture: user.picture || "",
    };
    persist();
  } catch (_) {
    /* identity is best-effort; syncing works without it */
  }
}

// ── public sync API (appearance-only) ─────────────────────────────────────────────
interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
  lastSyncedAt: string | null;
  version: number;
  appearance: Record<string, unknown> | null;
}

function syncStatus(): SyncStatus {
  return {
    enabled: state.enabled === true,
    connected: hasConnection(),
    name: state.identity?.name || null,
    email: state.identity?.email || null,
    picture: state.identity?.picture || null,
    lastSyncedAt: state.lastSyncedAt || null,
    version: state.version || 0,
    appearance: state.appearance || null,
  };
}

let settingsSync: SettingsSync | null = null;

function recordEngineStatus(status: SettingsSyncStatus): void {
  if (status.version !== null) state.version = status.version;
  if (status.lastSyncedAt !== null)
    state.lastSyncedAt = new Date(status.lastSyncedAt).toISOString();
  if (status.version !== null || status.lastSyncedAt !== null) persist();
}

function syncEngine(): SettingsSync {
  settingsSync ??= createSettingsSync(connect().locker(), {
    // The wire shape is { appearance: { theme }, prefs: { … } }. `appearance` is the browser's
    // (theme) and predates this; `prefs` is the daemon's portable AppSettings, added 2026-08-25 —
    // see SYNCED_PREF_KEYS in app-settings.ts for which ones travel and why the rest do not.
    // A second top-level key rather than folding prefs into `appearance` keeps the established
    // shape readable and keeps the two allowlists independently auditable.
    keys: ["appearance", "prefs"],
    read: () => ({
      appearance: state.appearance || {},
      prefs: readSyncedPrefs(),
    }),
    write: (patch) => {
      if (patch.appearance && typeof patch.appearance === "object") {
        state.appearance = patch.appearance as Record<string, unknown>;
        persist();
      }
      // Allowlist-filtered inside applySyncedPrefs, so a remote doc naming `autoUpdate` or
      // `outputRetentionDays` cannot switch either of them on here.
      applySyncedPrefs(patch.prefs);
    },
    onStatus: recordEngineStatus,
  });
  return settingsSync;
}

function requireSuccess(status: SettingsSyncStatus): SettingsSyncStatus {
  if (status.state === "synced") return status;
  if (status.state === "signed-out") {
    const error = new Error("not_signed_in") as Error & { code?: string };
    error.code = "not_signed_in";
    throw error;
  }
  throw status.error ?? new Error(`settings sync ended in ${status.state}`);
}

/** Flush the engine's current appearance snapshot immediately. */
async function pushNow(): Promise<void> {
  requireSuccess(await syncEngine().flush());
  await backfillIdentity();
}

/** Pull the remote doc and adopt its appearance. Returns the remote version. */
async function pullNow(): Promise<{ version: number }> {
  const status = requireSuccess(await syncEngine().pull());
  await backfillIdentity();
  return { version: status.version ?? 0 };
}

/** Turn sync on: pull the remote doc (adopting its appearance) or seed the store from local. */
async function enable(
  appearance?: Record<string, unknown>,
): Promise<{ status: SyncStatus }> {
  state.enabled = true;
  if (appearance && typeof appearance === "object")
    state.appearance = appearance;
  persist();
  if (hasConnection()) {
    requireSuccess(await syncEngine().hydrate({ seedIfEmpty: true }));
    await backfillIdentity();
  }
  return { status: syncStatus() };
}

/** Turn sync off. `forget` also disconnects — deletes the remote document, REVOKES the grant
 *  server-side (RFC 7009, the refresh-token family dies everywhere), and clears the session. */
async function disable(forget?: boolean): Promise<SyncStatus> {
  state.enabled = false;
  settingsSync?.stop();
  if (forget) {
    if (hasConnection()) {
      try {
        await (settingsSync ?? syncEngine()).locker.delete();
      } catch (_) {
        /* best-effort remote wipe */
      }
    }
    await connect().signOut({ revoke: true });
    state.identity = undefined;
    state.appearance = undefined;
    state.version = 0;
    state.lastSyncedAt = undefined;
  }
  settingsSync = null;
  persist();
  return syncStatus();
}

/** The web changed its theme while synced. The engine coalesces changes for 800 ms. */
async function updateAppearance(
  appearance?: Record<string, unknown>,
): Promise<void> {
  if (appearance && typeof appearance === "object")
    state.appearance = appearance;
  persist();
  if (state.enabled && hasConnection()) syncEngine().push();
}

/** Flush a pending debounce before daemon shutdown. */
async function flushPending(): Promise<void> {
  if (state.enabled && hasConnection()) {
    requireSuccess(await syncEngine().flushAndStop({ timeoutMs: 5_000 }));
    await backfillIdentity();
  }
}

/** Sign out / disconnect fully. */
async function logout(): Promise<void> {
  await disable(true);
}

export {
  initConnections,
  hasConnection,
  buildAuthorizeUrl,
  handleCallback,
  syncStatus,
  pushNow,
  pullNow,
  enable,
  disable,
  updateAppearance,
  flushPending,
  logout,
};

/**
 * "Sign in with Connections" + settings-sync route handler.
 *
 * Thin adapter over src/connections.ts (the daemon-side BFF, now a static import, see that
 * file's header). The browser only talks to these local daemon routes; the daemon holds the
 * refresh token and calls the store. RēDesign has no auth gate (local single-user daemon), the
 * sync ops themselves check for a connection. State-changing routes reuse the origin-guard
 * middleware. Ported from server/connections-routes.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import * as conn from "../../connections";

interface SyncErrorLike extends Error {
  code?: string;
  retryAfterSeconds?: number;
}

function syncError(e: unknown): { ok: false; error: string; retryAfterSeconds?: number } {
  const err = e as SyncErrorLike;
  const code = err?.code || (err?.message === "not_signed_in" ? "not_signed_in" : "sync_failed");
  const out: { ok: false; error: string; retryAfterSeconds?: number } = { ok: false, error: code };
  if (err && typeof err.retryAfterSeconds === "number") out.retryAfterSeconds = err.retryAfterSeconds;
  return out;
}

export function register(app: Hono, _deps: Deps): void {
  // ── OIDC login (full-page navigations, not /api) ──────────────────────────
  app.get("/oauth/login", async (c) => {
    const origin = new URL(c.req.url).origin;
    const authUrl = await conn.buildAuthorizeUrl(origin);
    return c.redirect(authUrl, 302);
  });

  app.get("/oauth/callback", async (c) => {
    const origin = new URL(c.req.url).origin;
    const code = c.req.query("code");
    const stateTok = c.req.query("state");
    let ok = false;
    try {
      ok = code && stateTok ? await conn.handleCallback(origin, code, stateTok) : false;
    } catch (_) {
      ok = false;
    }
    // If sync was already enabled, converge now that we have a token: pull-or-seed in the
    // background so the redirect doesn't wait on the network.
    if (ok && conn.syncStatus().enabled) void conn.enable().catch(() => {});
    return c.redirect(ok ? "/?connected=1" : "/?connect=failed", 302);
  });

  // ── identity ──────────────────────────────────────────────────────────────
  app.get("/api/auth/me", (c) => {
    const s = conn.syncStatus();
    return c.json({ ok: true, connected: s.connected, name: s.name, picture: s.picture, email: s.email });
  });

  app.post("/api/auth/logout", requireSameOrigin(), async (c) => {
    await conn.logout();
    return c.json({ ok: true });
  });

  // ── settings sync ───────────────────────────────────────────────────────────
  app.get("/api/settings/sync", (c) => {
    return c.json({ ok: true, ...conn.syncStatus() });
  });

  app.put("/api/settings/sync", requireSameOrigin(), async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) || {}) as { enabled?: boolean; forget?: boolean; appearance?: Record<string, unknown> };
    try {
      let out: unknown;
      if (b.enabled === true) out = (await conn.enable(b.appearance)).status;
      else if (b.enabled === false) out = await conn.disable(b.forget === true);
      else {
        if (b.appearance && typeof b.appearance === "object") await conn.updateAppearance(b.appearance);
        out = conn.syncStatus();
      }
      return c.json({ ok: true, ...(out as Record<string, unknown>) });
    } catch (e) {
      return c.json(syncError(e));
    }
  });

  app.post("/api/settings/sync/pull", requireSameOrigin(), async (c) => {
    try {
      await conn.pullNow();
      return c.json({ ok: true, ...conn.syncStatus() });
    } catch (e) {
      return c.json(syncError(e));
    }
  });

  app.post("/api/settings/sync/push", requireSameOrigin(), async (c) => {
    try {
      await conn.pushNow();
      return c.json({ ok: true, ...conn.syncStatus() });
    } catch (e) {
      return c.json(syncError(e));
    }
  });
}

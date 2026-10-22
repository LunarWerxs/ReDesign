/**
 * GET /api/keys, POST /api/keys/save · /delete. Ported from server.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { keySnapshot, saveApiKey, deleteApiKey, importKeys, type SaveApiKeyInput, type DeleteApiKeyInput, type ImportKeysInput } from "../../server/settings";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/keys", (c) => c.json(keySnapshot()));

  app.post("/api/keys/save", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as SaveApiKeyInput;
    return c.json({ keys: saveApiKey(body) });
  });

  app.post("/api/keys/delete", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as DeleteApiKeyInput;
    return c.json({ keys: deleteApiKey(body) });
  });

  // Paste one or many keys; auto-detect the service each belongs to and add them.
  app.post("/api/keys/import", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as ImportKeysInput;
    return c.json(await importKeys(body));
  });
}

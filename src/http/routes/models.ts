/**
 * GET /api/models/available · POST /api/models/save · /delete · /restore · /reorder.
 * Ported from server.js (save/delete/restore/reorder); /available is new.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { saveModel, setModelStarred, deleteModel, restoreModel, reorderModels, type ModelInput } from "../../config";
import { modelSettingsResponse } from "../../server/settings";
import { getAvailableModels } from "../../modelCatalog";
import { providerDefault } from "../../config/shared";

export function register(app: Hono, _deps: Deps): void {
  // GET, not a mutation, no requireSameOrigin, same as GET /api/keys. Free
  // metadata lookup: never triggers a paid generation call.
  app.get("/api/models/available", async (c) => {
    const provider = String(c.req.query("provider") || "").trim().toLowerCase();
    const baseUrl = String(c.req.query("baseUrl") || "").trim();
    const keyEnv = String(c.req.query("keyEnv") || "").trim();
    if (!provider) return c.json({ error: "provider is required" }, 400);
    const resolvedBaseUrl = baseUrl || providerDefault(provider, "baseUrl");
    const resolvedKeyEnv = keyEnv || providerDefault(provider, "keyEnv");
    const result = await getAvailableModels({ provider, baseUrl: resolvedBaseUrl, keyEnv: resolvedKeyEnv });
    return c.json(result);
  });

  app.post("/api/models/save", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as ModelInput;
    const model = saveModel(body);
    return c.json(modelSettingsResponse({ model }));
  });

  app.post("/api/models/star", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string; starred?: boolean };
    try {
      const model = setModelStarred(body.id as string, body.starred !== false);
      return c.json(modelSettingsResponse({ model }));
    } catch (e) {
      const status = (e as { status?: number }).status || 400;
      return c.json({ error: e instanceof Error ? e.message : "star failed" }, status as 400);
    }
  });

  app.post("/api/models/delete", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
    const id = deleteModel(body.id as string);
    return c.json(modelSettingsResponse({ id }));
  });

  app.post("/api/models/restore", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
    const model = restoreModel(body.id as string);
    return c.json(modelSettingsResponse({ model }));
  });

  app.post("/api/models/reorder", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { order?: unknown };
    try {
      reorderModels(body.order);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "reorder failed" }, 400);
    }
    return c.json(modelSettingsResponse({}));
  });
}

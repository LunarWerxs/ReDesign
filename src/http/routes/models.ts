/**
 * GET /api/models/available · POST /api/models/save · /delete · /restore · /reorder.
 * Ported from server.js (save/delete/restore/reorder); /available is new.
 */
import type { Context, Env, Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { loadModels, saveModel, setModelStarred, deleteModel, restoreModel, reorderModels, type ModelInput } from "../../config";
import { modelSettingsResponse } from "../../server/settings";
import { getAvailableModels } from "../../modelCatalog";
import { providerDefault } from "../../config/shared";

// The route bodies register() used to hold inline, pulled out to module level so each handler's
// branching scores against its own small function instead of register's — the same pattern
// runs.ts uses for handleRunEvents/handleRunRetry.
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

// A live catalog lookup forwards a stored credential. Only default provider bindings or bindings
// explicitly saved in the model catalog may select its destination and key pool.
function isAllowedCatalogBinding(provider: string, resolvedBaseUrl: string, resolvedKeyEnv: string): boolean {
  const isDefault = resolvedKeyEnv === providerDefault(provider, "keyEnv")
    && !!resolvedBaseUrl && stripTrailingSlashes(resolvedBaseUrl) === stripTrailingSlashes(providerDefault(provider, "baseUrl"));
  const isConfigured = loadModels().some((m) => m.provider === provider
    && m.keyEnv === resolvedKeyEnv && stripTrailingSlashes(m.baseUrl) === stripTrailingSlashes(resolvedBaseUrl));
  return isDefault || isConfigured;
}

async function handleModelsAvailable(c: Context<Env, "/api/models/available">) {
  const provider = String(c.req.query("provider") || "").trim().toLowerCase();
  const baseUrl = String(c.req.query("baseUrl") || "").trim();
  const keyEnv = String(c.req.query("keyEnv") || "").trim();
  if (!provider) return c.json({ error: "provider is required" }, 400);
  const resolvedBaseUrl = baseUrl || providerDefault(provider, "baseUrl");
  const resolvedKeyEnv = keyEnv || providerDefault(provider, "keyEnv");
  if (!isAllowedCatalogBinding(provider, resolvedBaseUrl, resolvedKeyEnv)) {
    return c.json({ code: "catalog_binding_required", error: "Catalog credentials must match a default provider or a saved model's provider, baseUrl and keyEnv" }, 400);
  }
  const result = await getAvailableModels({ provider, baseUrl: resolvedBaseUrl, keyEnv: resolvedKeyEnv });
  return c.json(result);
}

async function handleModelsSave(c: Context<Env, "/api/models/save">) {
  const body = ((await c.req.json().catch(() => ({}))) || {}) as ModelInput;
  const model = saveModel(body);
  return c.json(modelSettingsResponse({ model }));
}

async function handleModelsStar(c: Context<Env, "/api/models/star">) {
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string; starred?: boolean };
  try {
    const model = setModelStarred(body.id as string, body.starred !== false);
    return c.json(modelSettingsResponse({ model }));
  } catch (e) {
    const status = (e as { status?: number }).status || 400;
    return c.json({ error: e instanceof Error ? e.message : "star failed" }, status as 400);
  }
}

async function handleModelsDelete(c: Context<Env, "/api/models/delete">) {
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
  const id = deleteModel(body.id as string);
  return c.json(modelSettingsResponse({ id }));
}

async function handleModelsRestore(c: Context<Env, "/api/models/restore">) {
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
  const model = restoreModel(body.id as string);
  return c.json(modelSettingsResponse({ model }));
}

async function handleModelsReorder(c: Context<Env, "/api/models/reorder">) {
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { order?: unknown };
  try {
    reorderModels(body.order);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "reorder failed" }, 400);
  }
  return c.json(modelSettingsResponse({}));
}

export function register(app: Hono, _deps: Deps): void {
  // A live catalog lookup forwards a stored credential. Only default provider bindings or
  // bindings explicitly saved in the model catalog may select its destination and key pool.
  app.get("/api/models/available", requireSameOrigin(), handleModelsAvailable);

  app.post("/api/models/save", requireSameOrigin(), handleModelsSave);

  app.post("/api/models/star", requireSameOrigin(), handleModelsStar);

  app.post("/api/models/delete", requireSameOrigin(), handleModelsDelete);

  app.post("/api/models/restore", requireSameOrigin(), handleModelsRestore);

  app.post("/api/models/reorder", requireSameOrigin(), handleModelsReorder);
}

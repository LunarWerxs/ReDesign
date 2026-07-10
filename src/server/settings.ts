// Model/prompt settings snapshots for the API responses, plus the API-key
// pool CRUD (persisted into .env). Split out of ../server.js, see that
// file's requires.

import fs from "node:fs";
import path from "node:path";
import { ROOT, getKeyPool, keyId } from "../util";
import { loadModels, loadArchivedModels, loadPrompts } from "../config";
import { getKeyManager } from "../runner";
import type { Model } from "../config/models";
import type { KeyManager, Snapshot } from "../keyManager";

const ENV_FILE = path.join(ROOT, ".env");

interface PublicPrompt {
  id: string;
  label: string;
  description?: string;
  user: string;
}

function publicPrompts(): PublicPrompt[] {
  return loadPrompts().prompts.map((p2) => ({
    id: p2.id,
    label: p2.label,
    description: p2.description,
    user: p2.user,
  }));
}

interface PublicModel {
  id: string;
  label: string;
  provider: string;
  apiModel: string;
  keyEnv: string;
  baseUrl: string;
  vision: boolean;
  enabled: boolean;
  color: string | undefined;
  keys: number;
  maxTokens: number;
  temperature: number | undefined;
  tokenParam: string | undefined;
  supportsTemperature: boolean;
}

function publicModel(m: Model, km: KeyManager | null): PublicModel {
  return {
    id: m.id,
    label: m.label,
    provider: m.provider,
    apiModel: m.apiModel,
    keyEnv: m.keyEnv,
    baseUrl: m.baseUrl,
    vision: m.vision !== false,
    enabled: m.enabled !== false,
    color: m.color,
    keys: m.keyEnv ? (km ? km.poolSize(m.keyEnv) : getKeyPool(m.keyEnv).length) : 0,
    maxTokens: m.maxTokens,
    temperature: m.temperature,
    tokenParam: m.tokenParam,
    supportsTemperature: m.supportsTemperature !== false,
  };
}

interface ModelSettings {
  models: PublicModel[];
  archivedModels: PublicModel[];
}

function modelSettings(): ModelSettings {
  const km = getKeyManager();
  const models = loadModels();
  for (const m of models) km.registerPool(m.keyEnv);
  return {
    models: models.map((m) => publicModel(m, km)),
    archivedModels: loadArchivedModels().map((m) => publicModel(m, null)),
  };
}

function modelSettingsResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    ...modelSettings(),
    keys: keySnapshot(),
  };
}

function activeKeyPoolNames(): Set<string> {
  return new Set(loadModels().map((m) => m.keyEnv).filter(Boolean));
}

function filteredKeySnapshot(km: KeyManager = getKeyManager()): Snapshot {
  const activePools = activeKeyPoolNames();
  for (const poolName of activePools) km.registerPool(poolName);
  const snapshot = km.snapshot();
  return {
    ...snapshot,
    pools: snapshot.pools.filter((p2) => activePools.has(p2.pool)),
  };
}

function keySnapshot(): Snapshot {
  return filteredKeySnapshot(getKeyManager());
}

function registerActiveKeyPools(km: KeyManager = getKeyManager()): void {
  for (const m of loadModels()) km.registerPool(m.keyEnv);
}

function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function assertKeyPool(poolName: unknown): string {
  const pool = String(poolName || "").trim();
  if (!pool || !activeKeyPoolNames().has(pool)) throw statusError("unknown key pool", 400);
  return pool;
}

function normalizeApiKey(value: unknown): string {
  const key = String(value || "").trim();
  if (!key) throw statusError("api key is required", 400);
  if (/[\r\n,]/.test(key)) throw statusError("api key cannot contain commas or line breaks", 400);
  return key;
}

function setEnvKeyPool(poolName: string, keys: string[]): void {
  const value = keys.join(",");
  const original = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = !original || /\r?\n$/.test(original);
  const lines = original ? original.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const assignRe = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(poolName)}(?:_\\d+)?\\s*=`);
  const next: string[] = [];
  let wrote = false;

  for (const line of lines) {
    if (assignRe.test(line)) {
      if (!wrote) {
        next.push(`${poolName}=${value}`);
        wrote = true;
      }
      continue;
    }
    next.push(line);
  }
  if (!wrote) {
    if (next.length && next.at(-1) !== "") next.push("");
    next.push(`${poolName}=${value}`);
  }
  // .env holds secrets, write with owner-only permissions (0600).
  fs.writeFileSync(ENV_FILE, next.join(eol) + (hadTrailingNewline ? eol : ""), { mode: 0o600 });

  const indexedRe = new RegExp(`^${escapeRegExp(poolName)}_\\d+$`);
  for (const envKey of Object.keys(process.env)) {
    if (envKey === poolName || indexedRe.test(envKey)) delete process.env[envKey];
  }
  process.env[poolName] = value;
}

function reloadKeyPool(poolName: string, forgetIds: string[] = []): Snapshot {
  const km = getKeyManager();
  if (forgetIds.length) km.forget(poolName, forgetIds);
  km.reloadPool(poolName);
  registerActiveKeyPools(km);
  return filteredKeySnapshot(km);
}

interface SaveApiKeyInput {
  pool: string;
  id?: string;
  key: string;
}

function saveApiKey({ pool, id, key }: SaveApiKeyInput): Snapshot {
  const poolName = assertKeyPool(pool);
  const nextKey = normalizeApiKey(key);
  const existingId = String(id || "").trim();
  const keys = getKeyPool(poolName);
  const nextId = keyId(nextKey);

  if (existingId) {
    const idx = keys.findIndex((k) => keyId(k) === existingId);
    if (idx === -1) throw statusError("api key not found", 404);
    if (keys.some((k, i) => i !== idx && keyId(k) === nextId)) throw statusError("api key already exists in this pool", 409);
    const oldId = keyId(keys[idx] as string);
    keys[idx] = nextKey;
    setEnvKeyPool(poolName, keys);
    return reloadKeyPool(poolName, oldId === nextId ? [] : [oldId]);
  }

  if (keys.some((k) => keyId(k) === nextId)) throw statusError("api key already exists in this pool", 409);
  keys.push(nextKey);
  setEnvKeyPool(poolName, keys);
  return reloadKeyPool(poolName);
}

interface DeleteApiKeyInput {
  pool: string;
  id: string;
}

function deleteApiKey({ pool, id }: DeleteApiKeyInput): Snapshot {
  const poolName = assertKeyPool(pool);
  const deleteId = String(id || "").trim();
  if (!deleteId) throw statusError("id is required", 400);
  const keys = getKeyPool(poolName);
  const next = keys.filter((k) => keyId(k) !== deleteId);
  if (next.length === keys.length) throw statusError("api key not found", 404);
  setEnvKeyPool(poolName, next);
  return reloadKeyPool(poolName, [deleteId]);
}

export {
  publicPrompts,
  publicModel,
  modelSettings,
  modelSettingsResponse,
  keySnapshot,
  filteredKeySnapshot,
  saveApiKey,
  deleteApiKey,
};
export type { PublicPrompt, PublicModel, ModelSettings, SaveApiKeyInput, DeleteApiKeyInput };

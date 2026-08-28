import fs from "node:fs";
import { writeJSON, asciiSlug, uniqueSlugId, normalizeSelectionIds, type SelectionInput } from "../util";
import {
  MODELS_FILE,
  jsonCache,
  MODEL_ARCHIVE_KEY,
  MODEL_PROVIDERS,
  OPENAI_FAMILY,
  readConfig,
  providerDefault,
} from "./shared";

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

interface Model {
  id: string;
  label: string;
  provider: string;
  apiModel: string;
  keyEnv: string;
  baseUrl: string;
  vision?: boolean;
  maxTokens: number;
  supportsTemperature?: boolean;
  enabled?: boolean;
  // Surfaced at the top of the model picker (vs. tucked into "All models").
  // Purely a UI hint; the run path never reads it.
  starred?: boolean;
  color?: string;
  tokenParam?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
}

interface ModelsFileData {
  models: Model[];
  [MODEL_ARCHIVE_KEY]?: Model[];
  [key: string]: unknown;
}

function loadModels(): Model[] {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  return (data.models || []).filter((m) => m?.id);
}

function loadArchivedModels(): Model[] {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  return (data[MODEL_ARCHIVE_KEY] || []).filter((m) => m?.id);
}

function writeModelsData(data: ModelsFileData): void {
  writeJSON(MODELS_FILE, data);
  const st = fs.statSync(MODELS_FILE);
  jsonCache.set(MODELS_FILE, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    data,
  });
}

function getModel(id: string): Model | null {
  return loadModels().find((m) => m.id === id) || null;
}

// Resolve a model selection ('all' | id | id[] | {ids:[]}) to enabled configs.
function resolveModels(selection: SelectionInput): Model[] {
  const all = loadModels();
  const enabled = all.filter((m) => m.enabled !== false);
  const ids = normalizeSelectionIds(selection);
  if (!selection || (ids.length === 1 && ids[0] === "all")) return enabled;
  const set = new Set(ids);
  return enabled.filter((m) => set.has(m.id));
}

function normalizeModelId(id: unknown): string {
  const modelId = asciiSlug(id, "model");
  if (!modelId) throw statusError("model id is required", 400);
  return modelId;
}

interface ModelInput {
  id?: string;
  provider?: string;
  label?: string;
  apiModel?: string;
  keyEnv?: string;
  baseUrl?: string;
  maxTokens?: string | number;
  vision?: boolean;
  supportsTemperature?: boolean;
  enabled?: boolean;
  starred?: boolean;
  color?: string;
  tokenParam?: string;
  temperature?: string | number;
}

function resolveProvider(input: ModelInput, base: Partial<Model>): string {
  const provider = String(input.provider || base.provider || "").trim().toLowerCase();
  if (!MODEL_PROVIDERS.has(provider)) throw statusError("provider is required", 400);
  return provider;
}

function resolveLabel(input: ModelInput, base: Partial<Model>): string {
  const label = String(input.label || base.label || "").trim();
  if (!label) throw statusError("label is required", 400);
  return label;
}

function resolveModelIdField(input: ModelInput, base: Partial<Model>, existing: Model | null, models: Model[], label: string): string {
  const id = existing
    ? (base.id as string)
    : input.id
      ? normalizeModelId(input.id)
      : uniqueSlugId(models, label, null, "model");
  if (!id) throw statusError("model id is required", 400);
  return id;
}

function resolveApiModel(input: ModelInput, base: Partial<Model>): string {
  const apiModel = String(input.apiModel || base.apiModel || "").trim();
  if (!apiModel) throw statusError("api model is required", 400);
  return apiModel;
}

function resolveKeyEnv(input: ModelInput, base: Partial<Model>, provider: string): string {
  const keyEnv = String(input.keyEnv || base.keyEnv || providerDefault(provider, "keyEnv") || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw statusError("key env must be a valid environment variable name", 400);
  return keyEnv;
}

function resolveBaseUrl(input: ModelInput, base: Partial<Model>, provider: string): string {
  const baseUrl = String(input.baseUrl || base.baseUrl || providerDefault(provider, "baseUrl") || "").trim();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw statusError("base url must start with http:// or https://", 400);
  return baseUrl;
}

function resolveMaxTokens(input: ModelInput, base: Partial<Model>): number {
  const maxTokensRaw = input.maxTokens != null && input.maxTokens !== "" ? input.maxTokens : base.maxTokens;
  const maxTokens = parseInt(String(maxTokensRaw), 10);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw statusError("max tokens must be a positive number", 400);
  return maxTokens;
}

function resolveColor(input: ModelInput, base: Partial<Model>, provider: string): string | undefined {
  const color = String(input.color || base.color || providerDefault(provider, "color") || "").trim();
  if (!color) return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw statusError("color must be a 6-digit hex value", 400);
  return color;
}

function resolveTokenParam(input: ModelInput, base: Partial<Model>, provider: string): Model["tokenParam"] {
  if (!OPENAI_FAMILY.has(provider)) return undefined;
  const tokenParam = String(input.tokenParam || base.tokenParam || "").trim();
  return tokenParam === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
}

function resolveTemperature(input: ModelInput, base: Partial<Model>, supportsTemperature: boolean): number | undefined {
  if (!supportsTemperature) return undefined;
  const rawTemp = input.temperature != null && input.temperature !== "" ? input.temperature : base.temperature;
  if (rawTemp == null || rawTemp === "") return undefined;
  const temperature = Number(rawTemp);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw statusError("temperature must be between 0 and 2", 400);
  return temperature;
}

function normalizeModelInput(input: ModelInput = {}, existing: Model | null = null, models: Model[] = []): Model {
  const base: Partial<Model> = existing ? { ...existing } : {};
  const provider = resolveProvider(input, base);
  const label = resolveLabel(input, base);
  const id = resolveModelIdField(input, base, existing, models, label);
  const apiModel = resolveApiModel(input, base);
  const keyEnv = resolveKeyEnv(input, base, provider);
  const baseUrl = resolveBaseUrl(input, base, provider);
  const maxTokens = resolveMaxTokens(input, base);
  const supportsTemperature = input.supportsTemperature == null ? base.supportsTemperature !== false : !!input.supportsTemperature;

  return {
    ...base,
    id,
    label,
    provider,
    apiModel,
    keyEnv,
    baseUrl,
    vision: input.vision == null ? base.vision !== false : !!input.vision,
    maxTokens,
    supportsTemperature,
    enabled: input.enabled == null ? base.enabled !== false : !!input.enabled,
    starred: input.starred == null ? base.starred === true : !!input.starred,
    color: resolveColor(input, base, provider),
    tokenParam: resolveTokenParam(input, base, provider),
    temperature: resolveTemperature(input, base, supportsTemperature),
  };
}

function saveModel(input: ModelInput = {}): Model {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  const models = Array.isArray(data.models) ? [...data.models] : [];
  const archive = Array.isArray(data[MODEL_ARCHIVE_KEY]) ? [...(data[MODEL_ARCHIVE_KEY] as Model[])] : [];
  const existingId = String(input.id || "").trim();
  const existingIndex = existingId ? models.findIndex((m) => m.id === existingId) : -1;
  const archivedIndex = existingId ? archive.findIndex((m) => m.id === existingId) : -1;
  const existing = existingIndex >= 0 ? (models[existingIndex] as Model) : archivedIndex >= 0 ? (archive[archivedIndex] as Model) : null;
  const nextModel = normalizeModelInput(input, existing, models);

  const duplicate = models.find((m, i) => m.id === nextModel.id && i !== existingIndex);
  if (duplicate) throw statusError("model id already exists", 409);

  let nextModels: Model[];
  if (existingIndex >= 0) {
    nextModels = models.map((m, i) => (i === existingIndex ? nextModel : m));
  } else {
    nextModels = [...models, nextModel];
  }
  const nextArchive = archive.filter((m) => m.id !== nextModel.id);
  writeModelsData({ ...data, models: nextModels, [MODEL_ARCHIVE_KEY]: nextArchive });
  return nextModel;
}

function deleteModel(id: string): string {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  const modelId = String(id || "").trim();
  if (!modelId) throw statusError("id is required", 400);
  const models = Array.isArray(data.models) ? data.models : [];
  const existing = models.find((m) => m.id === modelId);
  if (!existing) throw statusError("model not found", 404);
  const archive = Array.isArray(data[MODEL_ARCHIVE_KEY]) ? (data[MODEL_ARCHIVE_KEY] as Model[]) : [];
  writeModelsData({
    ...data,
    models: models.filter((m) => m.id !== modelId),
    [MODEL_ARCHIVE_KEY]: [existing, ...archive.filter((m) => m.id !== modelId)],
  });
  return modelId;
}

function restoreModel(id: string): Model {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  const modelId = String(id || "").trim();
  if (!modelId) throw statusError("id is required", 400);
  const models = Array.isArray(data.models) ? [...data.models] : [];
  if (models.some((m) => m.id === modelId)) throw statusError("model already exists", 409);
  const archive = Array.isArray(data[MODEL_ARCHIVE_KEY]) ? [...(data[MODEL_ARCHIVE_KEY] as Model[])] : [];
  const existing = archive.find((m) => m.id === modelId);
  if (!existing) throw statusError("archived model not found", 404);
  const restored: Model = { ...existing, enabled: true };
  writeModelsData({
    ...data,
    models: [...models, restored],
    [MODEL_ARCHIVE_KEY]: archive.filter((m) => m.id !== modelId),
  });
  return restored;
}

// Toggle the picker "starred" hint on an active model. Kept separate from
// saveModel() so the client can star/unstar without re-validating the whole
// model form (base url, tokens, etc.).
function setModelStarred(id: string, starred: boolean): Model {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  const modelId = String(id || "").trim();
  if (!modelId) throw statusError("id is required", 400);
  const models = Array.isArray(data.models) ? [...data.models] : [];
  const idx = models.findIndex((m) => m.id === modelId);
  if (idx === -1) throw statusError("model not found", 404);
  const next: Model = { ...(models[idx] as Model), starred: !!starred };
  models[idx] = next;
  writeModelsData({ ...data, models });
  return next;
}

function reorderModels(orderedIds: unknown): Model[] {
  const data = readConfig<ModelsFileData>(MODELS_FILE, { models: [] });
  const models = Array.isArray(data.models) ? data.models : [];
  const ids = (Array.isArray(orderedIds) ? orderedIds : []).map(String);
  const byId = new Map(models.map((m) => [m.id, m]));
  const isPermutation =
    ids.length === models.length &&
    new Set(ids).size === models.length &&
    ids.every((id) => byId.has(id));
  if (!isPermutation) throw new Error("Reorder must list each current model id exactly once.");
  const nextModels = ids.map((id) => byId.get(id) as Model);
  writeModelsData({ ...data, models: nextModels });
  return nextModels.filter((m) => m?.id);
}

export {
  loadModels,
  loadArchivedModels,
  getModel,
  resolveModels,
  saveModel,
  setModelStarred,
  reorderModels,
  deleteModel,
  restoreModel,
};
export type { Model, ModelInput, ModelsFileData };

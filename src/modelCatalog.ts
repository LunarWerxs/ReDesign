/**
 * Model-catalog lookup: "what models can I type into the API-model field for
 * this provider?" Backs GET /api/models/available (src/http/routes/models.ts).
 *
 * Two tiers:
 *  - 'provider' (authoritative, live): calls the provider's own free list-models
 *    GET using the key ALREADY STORED for that provider's keyEnv pool (same
 *    bases/auth shapes providers.ts uses to actually call the model, so the
 *    listing matches how the app really talks to it). Costs nothing, these are
 *    metadata GETs, never a generation call.
 *  - 'catalog' (fallback): https://models.dev/api.json filtered to the
 *    provider, used when no key is stored or the live call fails for any
 *    reason. No key required.
 *
 * In-memory cache per (provider, baseUrl, keyId) for ~1 hour so repeated dialog
 * opens don't re-hit the network.
 */
import { getKeyPool } from "./util";

interface CatalogModel {
  id: string;
  label: string;
  source: "provider" | "catalog";
  // Whether the model accepts image input, when known (from models.dev metadata).
  // Undefined when we can't tell; callers should fall back to a sensible default.
  vision?: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // ~1 hour

interface CacheEntry {
  at: number;
  models: CatalogModel[];
}

const cache = new Map<string, CacheEntry>();

// Pragmatic exclude list: ids that are technically "models" the list-models API
// returns but are never something you'd pick as a RēDesign reimagining model
// (embeddings, speech-to-text, tts, moderation, image/video generation, rerankers).
// Deliberately simple substring/regex checks, not a clever classifier.
const EXCLUDE_PATTERNS: RegExp[] = [
  /embed/i,
  /whisper/i,
  /\btts\b/i,
  /text-to-speech/i,
  /speech/i,
  /moderation/i,
  /\bdall-?e\b/i,
  /image-gen/i,
  /\bimagen\b/i,
  /video/i,
  /rerank/i,
  /audio/i,
  /realtime/i,
  /transcribe/i,
  /computer-use/i,
  /aqa/i, // Gemini's "attributed question answering" utility model
];

function isExcluded(id: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(id));
}

function cacheKey(provider: string, baseUrl: string, keySuffix: string): string {
  return `${provider}::${baseUrl}::${keySuffix}`;
}

function getCached(key: string): CatalogModel[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.models;
}

function setCached(key: string, models: CatalogModel[]): void {
  cache.set(key, { at: Date.now(), models });
}

async function fetchJSON<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Live provider list-models calls, reuse the exact bases/auth shapes
// providers.ts uses so the listing matches how the app really calls the model.
// ---------------------------------------------------------------------------

interface AnthropicModelsResponse {
  data?: { id: string; display_name?: string }[];
}
async function listAnthropic(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const json = await fetchJSON<AnthropicModelsResponse>(`${baseUrl.replace(/\/$/, "")}/models?limit=1000`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  return (json.data || [])
    .map((m) => ({ id: m.id, label: m.display_name || m.id, source: "provider" as const }))
    .filter((m) => !isExcluded(m.id));
}

interface OpenAIModelsResponse {
  data?: { id: string }[];
}
// Covers OpenAI, DeepSeek, DashScope-compatible-mode (Qwen), all share the
// OpenAI-compatible GET /models { data: [{id}] } shape.
async function listOpenAICompatible(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const json = await fetchJSON<OpenAIModelsResponse>(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return (json.data || [])
    .map((m) => ({ id: m.id, label: m.id, source: "provider" as const }))
    .filter((m) => !isExcluded(m.id));
}

interface GeminiModelsResponse {
  models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
}
async function listGemini(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const json = await fetchJSON<GeminiModelsResponse>(
    `${baseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`,
  );
  return (json.models || [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => {
      const id = (m.name || "").replace(/^models\//, "");
      return { id, label: m.displayName || id, source: "provider" as const };
    })
    .filter((m) => m.id && !isExcluded(m.id));
}

async function listLiveForProvider(provider: string, baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  if (provider === "anthropic") return listAnthropic(baseUrl, apiKey);
  if (provider === "gemini" || provider === "google") return listGemini(baseUrl, apiKey);
  // openai / openai-compatible / anything else sharing the chat-completions shape
  return listOpenAICompatible(baseUrl, apiKey);
}

/**
 * Does `apiKey` authenticate against this provider/baseUrl? Reuses the provider's
 * free list-models GET (same call getAvailableModels uses): a resolved response
 * means the key was accepted, a throw (401/403/network) means it was not. Used by
 * keyDetect.ts to disambiguate a pasted key whose prefix is shared across services
 * (a bare `sk-` could be OpenAI, DeepSeek, Qwen or Moonshot). Read-only, never a
 * generation call. NOTE: only sound for services whose list-models endpoint
 * REQUIRES auth; callers must not probe endpoints that return a public catalog
 * without a key (e.g. OpenRouter), or every key would false-positive.
 */
async function probeKey(provider: string, baseUrl: string, apiKey: string, timeoutMs = 8000): Promise<boolean> {
  if (!apiKey || !baseUrl) return false;
  try {
    if (provider === "anthropic") {
      await fetchJSON(`${baseUrl.replace(/\/$/, "")}/models?limit=1`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      }, timeoutMs);
    } else if (provider === "gemini" || provider === "google") {
      await fetchJSON(`${baseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(apiKey)}&pageSize=1`, undefined, timeoutMs);
    } else {
      await fetchJSON(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` } }, timeoutMs);
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// models.dev fallback catalog (no key needed)
// ---------------------------------------------------------------------------
const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevModel {
  id?: string;
  name?: string;
  modalities?: { input?: string[]; output?: string[] };
}

// True if models.dev reports image among a model's accepted input modalities.
function modelsDevVision(info: ModelsDevModel): boolean | undefined {
  const input = info.modalities?.input;
  return Array.isArray(input) ? input.includes("image") : undefined;
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

// Maps our provider id to the models.dev provider key(s) most likely to hold
// its catalog. models.dev keys providers by their own slug, which doesn't
// always match ours 1:1 (e.g. our "gemini"/"google" both -> their "google").
const MODELS_DEV_PROVIDER_KEYS: Record<string, string[]> = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  "openai-compatible": ["openai"],
  gemini: ["google"],
  google: ["google"],
};

let modelsDevCache: { at: number; data: ModelsDevCatalog } | null = null;
async function fetchModelsDev(): Promise<ModelsDevCatalog> {
  if (modelsDevCache && Date.now() - modelsDevCache.at <= CACHE_TTL_MS) return modelsDevCache.data;
  const data = await fetchJSON<ModelsDevCatalog>(MODELS_DEV_URL);
  modelsDevCache = { at: Date.now(), data };
  return data;
}

async function listFromModelsDev(provider: string): Promise<CatalogModel[]> {
  const data = await fetchModelsDev();
  const providerKeys = MODELS_DEV_PROVIDER_KEYS[provider] || [provider];
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const key of providerKeys) {
    const models = data[key]?.models;
    if (!models) continue;
    for (const [modelId, info] of Object.entries(models)) {
      const id = info.id || modelId;
      if (!id || seen.has(id) || isExcluded(id)) continue;
      seen.add(id);
      out.push({ id, label: info.name || id, source: "catalog", vision: modelsDevVision(info) });
    }
  }
  return out;
}

// Enrich a live provider listing with vision info from the models.dev catalog
// (the live list-models endpoints don't report modality). Opportunistic and
// non-fetching: it only uses an already-cached models.dev blob so it never adds
// a network round-trip to a browse. Matches by exact id; leaves vision undefined
// when models.dev isn't cached yet or has no entry for the id.
function enrichVision(provider: string, models: CatalogModel[]): void {
  const data = modelsDevCache && Date.now() - modelsDevCache.at <= CACHE_TTL_MS ? modelsDevCache.data : null;
  if (!data) return;
  const providerKeys = MODELS_DEV_PROVIDER_KEYS[provider] || [provider];
  const vision = new Map<string, boolean>();
  for (const key of providerKeys) {
    const md = data[key]?.models;
    if (!md) continue;
    for (const [modelId, info] of Object.entries(md)) {
      const v = modelsDevVision(info);
      if (v !== undefined) vision.set(info.id || modelId, v);
    }
  }
  for (const m of models) if (m.vision === undefined && vision.has(m.id)) m.vision = vision.get(m.id);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export interface AvailableModelsResult {
  models: CatalogModel[];
  source: "provider" | "catalog";
}

/**
 * Resolve the list of model ids offered for `provider`/`baseUrl`. Tries the
 * live provider call first using the given keyEnv's stored key (round-robin
 * pool, the first key is fine for a metadata GET); falls back to the
 * models.dev catalog when no key is stored or the live call throws.
 */
export async function getAvailableModels(opts: {
  provider: string;
  baseUrl: string;
  keyEnv?: string;
}): Promise<AvailableModelsResult> {
  const { provider, baseUrl } = opts;
  const keyEnv = opts.keyEnv || "";
  const keys = keyEnv ? getKeyPool(keyEnv) : [];
  const apiKey = keys[0];

  if (apiKey) {
    const key = cacheKey(provider, baseUrl, apiKey.slice(0, 12));
    const cached = getCached(key);
    if (cached) return { models: cached, source: "provider" };
    try {
      const models = await listLiveForProvider(provider, baseUrl, apiKey);
      if (models.length) {
        enrichVision(provider, models);
        setCached(key, models);
        return { models, source: "provider" };
      }
      // Empty-but-ok response: fall through to catalog rather than show nothing.
    } catch {
      // Live call failed (network, bad key, provider outage), fall back below.
    }
  }

  const fallbackKey = cacheKey(provider, baseUrl, "__catalog__");
  const cachedFallback = getCached(fallbackKey);
  if (cachedFallback) return { models: cachedFallback, source: "catalog" };
  try {
    const models = await listFromModelsDev(provider);
    setCached(fallbackKey, models);
    return { models, source: "catalog" };
  } catch {
    return { models: [], source: "catalog" };
  }
}

export { probeKey };

/** Test-only: clear both the per-(provider,baseUrl,key) cache and the shared
 * models.dev blob cache so each test starts from a clean slate. Not used by
 * any production code path. */
export function _resetCacheForTests(): void {
  cache.clear();
  modelsDevCache = null;
}

export type { CatalogModel };

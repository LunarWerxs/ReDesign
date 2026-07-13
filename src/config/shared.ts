import fs from "node:fs";
import path from "node:path";
import { ROOT, readJSON } from "../util";

const MODELS_FILE = path.join(ROOT, "src", "config", "models.json");
const PROMPTS_FILE = path.join(ROOT, "src", "config", "prompts.json");
const PROMPTS_DEFAULTS_FILE = path.join(ROOT, "src", "config", "prompts.defaults.json");
const PRICING_FILE = path.join(ROOT, "src", "config", "pricing.json");

interface JsonCacheEntry<T> {
  mtimeMs: number;
  size: number;
  data: T;
}

const jsonCache = new Map<string, JsonCacheEntry<unknown>>();
const MODEL_ARCHIVE_KEY = "modelArchive";

const MODEL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-compatible",
  "gemini",
  "google",
  "deepseek",
  "qwen",
  "xai",
  "openrouter",
  "groq",
  "mistral",
  "moonshot",
  "metaai",
]);

// Every provider that speaks the OpenAI chat-completions shape (Bearer auth,
// GET /models listing, max_tokens vs max_completion_tokens). Used to pick the
// OpenAI adapter (providers.ts), gate the tokenParam field (config/models.ts),
// and drive which services an ambiguous `sk-` key is probed against (keyDetect.ts).
const OPENAI_FAMILY = new Set([
  "openai",
  "openai-compatible",
  "deepseek",
  "qwen",
  "xai",
  "openrouter",
  "groq",
  "mistral",
  "moonshot",
  "metaai",
]);

// Display names for grouping the picker by service and labelling key-import
// results. The catalog's Model.label is per-model; this is per-provider.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
  gemini: "Google Gemini",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  xai: "xAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  moonshot: "Moonshot",
  metaai: "Meta AI",
};

interface ProviderDefaults {
  baseUrl: string;
  keyEnv: string;
  color: string;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEYS",
    color: "#a06bff",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEYS",
    color: "#10a37f",
  },
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_COMPATIBLE_API_KEYS",
    color: "#4d6bfe",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEYS",
    color: "#4285f4",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEYS",
    color: "#4285f4",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEYS",
    color: "#4d6bfe",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "QWEN_API_KEYS",
    color: "#615ced",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEYS",
    color: "#1f6feb",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEYS",
    color: "#6467f2",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEYS",
    color: "#f55036",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEYS",
    color: "#ff7000",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: "MOONSHOT_API_KEYS",
    color: "#16b8a6",
  },
  metaai: {
    baseUrl: "https://api.meta.ai/v1",
    keyEnv: "METAAI_API_KEYS",
    color: "#0866ff",
  },
};

function readConfig<T>(file: string, fallback: T): T {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return fallback;
  }
  const cached = jsonCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data as T;
  const data = readJSON(file, fallback);
  jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function providerDefault(provider: string, key: keyof ProviderDefaults): string {
  return PROVIDER_DEFAULTS[provider]?.[key] || "";
}

export {
  MODELS_FILE,
  PROMPTS_FILE,
  PROMPTS_DEFAULTS_FILE,
  PRICING_FILE,
  jsonCache,
  MODEL_ARCHIVE_KEY,
  MODEL_PROVIDERS,
  OPENAI_FAMILY,
  PROVIDER_LABELS,
  PROVIDER_DEFAULTS,
  readConfig,
  providerDefault,
};
export type { ProviderDefaults, JsonCacheEntry };

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

const MODEL_PROVIDERS = new Set(["anthropic", "openai", "openai-compatible", "gemini", "google"]);

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
  PROVIDER_DEFAULTS,
  readConfig,
  providerDefault,
};
export type { ProviderDefaults, JsonCacheEntry };

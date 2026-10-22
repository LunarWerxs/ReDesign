/**
 * Figure out which AI service a pasted API key belongs to, so a user can paste a
 * blob of keys (one, or many, in any layout) and have each routed to the right
 * provider pool automatically. Two stages:
 *
 *  1. Prefix classification (offline, instant): `sk-ant-` -> Anthropic,
 *     `AIza...` -> Google, `sk-proj-/sk-svcacct-/sk-admin-` -> OpenAI,
 *     `xai-` -> xAI, `sk-or-v1-` -> OpenRouter, `gsk_` -> Groq,
 *     `LLM_<appid>_` -> Meta AI (Muse Spark).
 *  2. Live probe (only when the prefix is ambiguous): a bare `sk-` is shared by
 *     OpenAI-legacy, DeepSeek, Qwen and Moonshot keys, so we try the key against
 *     each configured candidate service's free, read-only list-models GET and
 *     take the first that accepts it (see modelCatalog.probeKey).
 *
 * "Brand" is the stable service identity a key routes to. It collapses provider
 * ids that are really the same service (gemini + google, openai + openai-compatible)
 * so one Google key lands in every Gemini pool, etc.
 */
import { probeKey } from "./modelCatalog";
import { PROVIDER_LABELS } from "./config/shared";

export interface KeyService {
  pool: string; // keyEnv, e.g. OPENAI_API_KEYS
  provider: string; // adapter/provider id from a representative model
  baseUrl: string;
  brand: string; // stable service identity
  label: string; // display name
}

export interface PrefixClass {
  brand: string | null;
  ambiguous: boolean; // true = a bare `sk-` that needs a probe to disambiguate
}

export interface BrandResolution {
  brand: string | null;
  probed: boolean;
}

/** Collapse provider ids that are the same *service* into one brand. */
export function providerToBrand(provider: string): string {
  const p = (provider || "").toLowerCase().trim();
  if (p === "google" || p === "gemini") return "google";
  if (p === "openai-compatible") return "openai";
  return p;
}

export function brandLabel(brand: string): string {
  if (!brand) return "Unknown";
  return PROVIDER_LABELS[brand] || brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** Build the list of probeable/routable services from the active model catalog,
 * one per key pool (keyEnv). A brand can span several pools (Gemini flash+pro). */
export function servicesFromModels(
  models: { provider?: string; keyEnv?: string; baseUrl?: string }[],
): KeyService[] {
  const byPool = new Map<string, KeyService>();
  for (const m of models) {
    const pool = (m.keyEnv || "").trim();
    const provider = (m.provider || "").trim().toLowerCase();
    const baseUrl = (m.baseUrl || "").trim();
    if (!pool || !provider || !baseUrl || byPool.has(pool)) continue;
    const brand = providerToBrand(provider);
    byPool.set(pool, { pool, provider, baseUrl, brand, label: brandLabel(brand) });
  }
  return [...byPool.values()];
}

/** Every pool that a detected brand should populate. */
export function poolsForBrand(brand: string, services: KeyService[]): string[] {
  return services.filter((s) => s.brand === brand).map((s) => s.pool);
}

function looksLikeKey(tok: string): boolean {
  if (tok.length < 16 || tok.length > 400) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{15,}$/.test(tok);
}

/**
 * Split a pasted blob into candidate keys. Accepts newlines, commas, spaces and
 * semicolons as separators, tolerates `NAME=key` / `export NAME=key` env lines
 * (taking the value side), strips surrounding quotes, drops `#` comment lines,
 * and dedupes. Capped so a giant paste can't fan out unboundedly.
 */
export function parseKeyBlob(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.toLowerCase().startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq !== -1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq).trim())) {
      line = line.slice(eq + 1).trim();
    }
    for (let tok of line.split(/[\s,;]+/)) {
      tok = tok.trim().replace(/^['"]+|['"]+$/g, "");
      if (!looksLikeKey(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= 100) return out;
    }
  }
  return out;
}

/** Classify a key by prefix alone. `ambiguous` marks a bare `sk-` that needs a probe. */
export function classifyKeyPrefix(key: string): PrefixClass {
  const k = key || "";
  if (/^sk-ant-/.test(k)) return { brand: "anthropic", ambiguous: false };
  if (/^AIza[0-9A-Za-z_-]/.test(k)) return { brand: "google", ambiguous: false };
  if (/^sk-(?:proj|svcacct|admin)-/.test(k)) return { brand: "openai", ambiguous: false };
  if (/^xai-/.test(k)) return { brand: "xai", ambiguous: false };
  if (/^sk-or-v1-/.test(k)) return { brand: "openrouter", ambiguous: false };
  if (/^gsk_/.test(k)) return { brand: "groq", ambiguous: false };
  if (/^LLM_[0-9]/.test(k)) return { brand: "metaai", ambiguous: false }; // Meta AI / Muse Spark: LLM_<appid>_<secret>
  if (/^sk-[A-Za-z0-9]/.test(k)) return { brand: null, ambiguous: true }; // OpenAI-legacy / DeepSeek / Qwen / Moonshot
  return { brand: null, ambiguous: false }; // unrecognized shape (e.g. Mistral's raw hex)
}

// OpenRouter's list-models GET is public (no auth), so a probe there would
// accept ANY key. Never probe it; its keys carry the sk-or-v1- prefix anyway.
const PROBE_EXCLUDE_BRANDS = new Set(["openrouter"]);
// The services that actually issue a bare `sk-` key, i.e. the only sane
// candidates when disambiguating one.
const AMBIGUOUS_SK_BRANDS = new Set(["openai", "deepseek", "qwen", "moonshot"]);
// Probe order: most common first, so the common case resolves on the first try.
const PROBE_PRIORITY = ["openai", "anthropic", "google", "deepseek", "qwen", "moonshot", "mistral", "xai", "groq"];

/**
 * Resolve a key to its brand. Confident prefixes return immediately with no
 * network call. Otherwise probe the configured candidate services and return the
 * first that authenticates (or null if none do / none are configured).
 */
export async function resolveKeyBrand(key: string, services: KeyService[]): Promise<BrandResolution> {
  const { brand, ambiguous } = classifyKeyPrefix(key);
  if (brand) return { brand, probed: false };

  const byBrand = new Map<string, KeyService>();
  for (const s of services) if (!byBrand.has(s.brand)) byBrand.set(s.brand, s);

  const candidates = [...byBrand.values()]
    .filter((s) => (ambiguous ? AMBIGUOUS_SK_BRANDS.has(s.brand) : !PROBE_EXCLUDE_BRANDS.has(s.brand)))
    .sort((a, b) => {
      const ai = PROBE_PRIORITY.indexOf(a.brand);
      const bi = PROBE_PRIORITY.indexOf(b.brand);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  for (const s of candidates) {
    if (await probeKey(s.provider, s.baseUrl, key)) return { brand: s.brand, probed: true };
  }
  return { brand: null, probed: candidates.length > 0 };
}

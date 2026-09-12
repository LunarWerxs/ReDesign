#!/usr/bin/env bun
/**
 * Refresh src/config/pricing.json from free, no-auth internet pricing sources.
 *
 * CHAIN (in order): LiteLLM -> CloudPrice -> OpenRouter.
 *
 * 1. LiteLLM's community-maintained price/context-window catalog, 
 *    https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *    ~1.6MB JSON keyed by model id (bare ids like "claude-opus-4-8", or
 *    provider-prefixed like "openrouter/qwen/..."), USD-per-token fields
 *    `input_cost_per_token` / `output_cost_per_token`.
 * 2. CloudPrice's mirror of the same LiteLLM schema, refreshed daily, 
 *    https://cloudprice.net/api/v2/ai/litellm_model_prices.json
 *    SAME shape/fields as LiteLLM (input_cost_per_token/output_cost_per_token),
 *    no key required. Keys are often provider-prefixed (e.g.
 *    "dashscope/qwen3.5-plus", "openrouter/qwen/..."). When consulting
 *    CloudPrice we PREFER a direct-provider entry (dashscope/, anthropic/,
 *    gemini/, deepseek/, or bare) and NEVER take an "openrouter/"-prefixed
 *    entry from it -- that resale tier is what the OpenRouter fallback below
 *    is for.
 * 3. OpenRouter's public model list (final fallback), 
 *    https://openrouter.ai/api/v1/models
 *    {data:[{id, pricing:{prompt, completion}}]}, USD-per-token strings.
 *
 * For each of the 6 models shipped in src/config/models.json, SOURCE_MAP below
 * gives the exact key to look up in each source (found by inspecting the real
 * fetched JSON on 2026-07-05, see the comments per entry). Converts USD/token
 * -> USD/Mtok (x1_000_000), writes src/config/pricing.json preserving its exact
 * shape: { _comment, lastUpdated, prices: { [modelId]: { inputPerMtok,
 * outputPerMtok, currency, estimate, source } } }.
 *
 * A model whose SOURCE_MAP entry isn't found in any of the three sources keeps
 * its existing pricing.json entry untouched (estimate:true stays estimate:true).
 *
 * BEST-EFFORT CROSS-CHECK: also fetches https://models.dev/api.json (no key;
 * nested providers -> models with a `cost` object already priced per Mtok --
 * no conversion needed). For each of our models, if a same-name entry exists
 * there and its price differs from the chosen chain price by more than 10%,
 * prints a console WARNING naming both numbers. models.dev is never written
 * to pricing.json -- advisory only.
 *
 * Run: `bun run update-pricing` (== `bun run scripts/update-pricing.ts`)
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJSON, writeJSON } from "../src/util";

const ROOT = join(import.meta.dir, "..");
const PRICING_FILE = join(ROOT, "src", "config", "pricing.json");
const MODELS_FILE = join(ROOT, "src", "config", "models.json");

const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CLOUDPRICE_URL = "https://cloudprice.net/api/v2/ai/litellm_model_prices.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const MODELSDEV_URL = "https://models.dev/api.json";

// ---------------------------------------------------------------------------
// SOURCE_MAP, our model id -> where to find its price in each source.
// Every key below was confirmed against the live fetched JSON on 2026-09-12,
// with usable flat cost fields, not guessed blind. The per-Mtok figures in the
// notes are what the sources returned that day, recorded so a future reader can
// tell a key that MOVED from a price that merely CHANGED:
//   - claude-opus-5:         LiteLLM bare key "claude-opus-5", $5 / $25.
//   - claude-fable-5-1:      LiteLLM bare key "claude-fable-5-1", $10 / $50.
//                            OpenRouter spells it "anthropic/claude-fable-5.1",
//                            a dot where our id has a dash.
//   - gpt-6-astra:           LiteLLM bare key "gpt-6-astra", $10 / $50. Do NOT take
//                            "gpt-6-astra-pro", a separate and dearer model.
//   - gpt-5.5:               LiteLLM bare key "gpt-5.5", $5 / $30.
//   - gpt-5.6:               our apiModel is the concrete "gpt-5.6-sol", so the key
//                            names that rather than the family, $4 / $20 (the bare
//                            "gpt-5.6" key happens to carry the same numbers today).
//                            OpenRouter resells the same model at $2 / $10, which the
//                            chain only reaches if LiteLLM and CloudPrice are both down.
//   - gpt-5.6-terra:         LiteLLM bare key "gpt-5.6-terra", $2 / $12.
//   - gpt-5.6-luna:          LiteLLM bare key "gpt-5.6-luna", $0.20 / $1.20.
//   - gemini-flash-latest:   apiModel unpinned to Google's alias (owner policy 2026-09-03).
//                            THE CATALOG KEY BELOW IS NOT THE ALIAS. LiteLLM/CloudPrice/
//                            OpenRouter price CONCRETE models, so the key has to name whatever
//                            the alias currently resolves to: gemini-3.8-flash as of 2026-09-02.
//                            Verified sourced (estimate:false) from LiteLLM on 2026-09-03 at
//                            $0.75/$3.75 per Mtok, unchanged on 2026-09-12.
//                            THIS KEY GOES STALE WHEN GOOGLE MOVES THE ALIAS, and the failure
//                            is quiet: the run just reports this model as "kept as estimate:true"
//                            instead of erroring. If you see that, re-point the key at the new
//                            concrete model rather than assuming the price is unchanged.
//   - gemini-pro-latest:     Same arrangement: alias in models.json, concrete model in the key.
//                            Currently gemini-3-pro-preview; verified sourced from LiteLLM on
//                            2026-09-03 at $2/$12 per Mtok. Same staleness caveat as above.
//                            OpenRouter no longer lists it at all, so that last fallback is dead
//                            for this one and the first two sources are load-bearing.
//   - deepseek-4.1-flash:    THE SAME ALIAS ARRANGEMENT as the gemini pair, and worth reading
//                            before touching. Our apiModel is DeepSeek's own moving name
//                            "deepseek-flash"; the price sources carry concrete models only, and
//                            as of 2026-09-12 no source has a "4.1" key at all. The concrete
//                            flash tier is "deepseek/deepseek-v4-flash" at $0.44 / $1.32, which
//                            is also exactly what the vision-exp build of it costs. Re-point this
//                            the day DeepSeek ships a distinct 4.1 entry. OpenRouter's
//                            "deepseek/deepseek-v4-flash-0731" is a resale tier at $0.04 / $0.08,
//                            30x under the direct price, which is precisely why OpenRouter sits
//                            last in the chain and must not be promoted above it.
//   - qwen-3.8-flash:        LiteLLM has NO direct-provider key for this one (there is no
//                            "dashscope/qwen3.8-flash"), only openrouter/ and together_ai/
//                            mirrors, and we never take an openrouter/-prefixed entry out of
//                            CloudPrice. So the first two sources miss by design and the
//                            OpenRouter step resolves "qwen/qwen3.8-flash" at $0.15 / $0.47.
//   - qwen-3.8-max:          LiteLLM/CloudPrice key "dashscope/qwen3.8-max", $2 / $6. OpenRouter
//                            pins a dated build, "qwen/qwen3.8-max-0902", at the same numbers.
//   - muse-spark-1.3:        "meta/muse-spark-1.3" in both sources, $1.25 / $4.25. Do NOT take
//                            "meta/muse-spark-1.3-contributor", which is a different tier.
//   - kimi-k3:               LiteLLM "moonshot/kimi-k3", $3 / $15. OpenRouter spells the vendor
//                            "moonshotai/kimi-k3" and resells at $2.30 / $11.55. Our catalog
//                            reaches the model through the qwen-compatible endpoint (apiModel
//                            "kimi/kimi-k3"), which changes the route, not who bills it.
//
// Models the app no longer ships (claude-opus-4-8, deepseek-v4-pro, qwen-3.5-plus,
// muse-spark-1.1) are dropped from this map but their pricing.json rows are left
// alone on purpose: buildNextPrices is additive, and an old run's manifest still
// needs its model's price to render a cost.
// ---------------------------------------------------------------------------
interface SourceMapEntry {
  litellmKey: string;
  /** Same key used against both LiteLLM and CloudPrice (identical schema). */
  cloudpriceKey: string;
  openrouterKey: string;
}

const SOURCE_MAP: Record<string, SourceMapEntry> = {
  "claude-opus-5": {
    litellmKey: "claude-opus-5",
    cloudpriceKey: "claude-opus-5",
    openrouterKey: "anthropic/claude-opus-5",
  },
  "claude-fable-5-1": {
    litellmKey: "claude-fable-5-1",
    cloudpriceKey: "claude-fable-5-1",
    openrouterKey: "anthropic/claude-fable-5.1",
  },
  "gpt-6-astra": {
    litellmKey: "gpt-6-astra",
    cloudpriceKey: "gpt-6-astra",
    openrouterKey: "openai/gpt-6-astra",
  },
  "gpt-5.5": {
    litellmKey: "gpt-5.5",
    cloudpriceKey: "gpt-5.5",
    openrouterKey: "openai/gpt-5.5",
  },
  "gpt-5.6": {
    litellmKey: "gpt-5.6-sol",
    cloudpriceKey: "gpt-5.6-sol",
    openrouterKey: "openai/gpt-5.6-sol",
  },
  "gpt-5.6-terra": {
    litellmKey: "gpt-5.6-terra",
    cloudpriceKey: "gpt-5.6-terra",
    openrouterKey: "openai/gpt-5.6-terra",
  },
  "gpt-5.6-luna": {
    litellmKey: "gpt-5.6-luna",
    cloudpriceKey: "gpt-5.6-luna",
    openrouterKey: "openai/gpt-5.6-luna",
  },
  "gemini-flash-latest": {
    litellmKey: "gemini-3.8-flash",
    cloudpriceKey: "gemini-3.8-flash",
    openrouterKey: "google/gemini-3.8-flash",
  },
  "gemini-pro-latest": {
    litellmKey: "gemini-3-pro-preview",
    cloudpriceKey: "gemini-3-pro-preview",
    openrouterKey: "google/gemini-3-pro-preview",
  },
  "deepseek-4.1-flash": {
    litellmKey: "deepseek/deepseek-v4-flash",
    cloudpriceKey: "deepseek/deepseek-v4-flash",
    openrouterKey: "deepseek/deepseek-v4-flash-0731",
  },
  "qwen-3.8-flash": {
    litellmKey: "dashscope/qwen3.8-flash",
    cloudpriceKey: "dashscope/qwen3.8-flash",
    openrouterKey: "qwen/qwen3.8-flash",
  },
  "qwen-3.8-max": {
    litellmKey: "dashscope/qwen3.8-max",
    cloudpriceKey: "dashscope/qwen3.8-max",
    openrouterKey: "qwen/qwen3.8-max-0902",
  },
  "muse-spark-1.3": {
    litellmKey: "meta/muse-spark-1.3",
    cloudpriceKey: "meta/muse-spark-1.3",
    openrouterKey: "meta/muse-spark-1.3",
  },
  "kimi-k3": {
    litellmKey: "moonshot/kimi-k3",
    cloudpriceKey: "moonshot/kimi-k3",
    openrouterKey: "moonshotai/kimi-k3",
  },
};

interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  currency: string;
  estimate?: boolean;
  source?: "litellm" | "cloudprice" | "openrouter" | "manual";
}

interface PricingFileData {
  _comment?: string;
  lastUpdated?: string;
  prices: Record<string, ModelPrice>;
  [key: string]: unknown;
}

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  [key: string]: unknown;
}
type LiteLLMCatalog = Record<string, LiteLLMEntry>;
// CloudPrice mirrors LiteLLM's exact schema.
type CloudPriceEntry = LiteLLMEntry;
type CloudPriceCatalog = Record<string, CloudPriceEntry>;

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string; [key: string]: unknown };
  [key: string]: unknown;
}
interface OpenRouterCatalog {
  data: OpenRouterModel[];
}

interface ModelsDevCost {
  input?: number;
  output?: number;
  [key: string]: unknown;
}
interface ModelsDevModel {
  id?: string;
  cost?: ModelsDevCost;
  [key: string]: unknown;
}
interface ModelsDevProvider {
  id?: string;
  models?: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** USD-per-token -> USD-per-Mtok, rounded to at most 4 significant decimals. */
function perTokenToPerMtok(perToken: number): number {
  const perMtok = perToken * 1_000_000;
  if (!Number.isFinite(perMtok) || perMtok <= 0) return 0;
  // Round to <=4 significant decimal digits without over-rounding small values
  // (e.g. 0.435 stays 0.435, not 0.44), round to 4 decimals then trim zeros.
  const rounded = Math.round(perMtok * 10_000) / 10_000;
  return rounded;
}

interface SourcedPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  source: "litellm" | "cloudprice" | "openrouter";
}

/**
 * Look up one model's price in a LiteLLM-schema catalog (used for both
 * LiteLLM itself and CloudPrice, which mirrors the same shape). Returns null
 * if the key is missing, or if it lacks usable flat per-token cost fields
 * (e.g. dashscope's qwen entry in LiteLLM only carries `tiered_pricing`, no
 * flat input_cost_per_token).
 */
function priceFromLiteLLMSchema(
  catalog: LiteLLMCatalog,
  key: string,
  source: "litellm" | "cloudprice",
): SourcedPrice | null {
  const entry = catalog[key];
  if (!entry) return null;
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number" || input <= 0 || output <= 0) return null;
  return {
    inputPerMtok: perTokenToPerMtok(input),
    outputPerMtok: perTokenToPerMtok(output),
    source,
  };
}

/** Look up one model's price in the LiteLLM catalog. Returns null if missing/unusable. */
function priceFromLiteLLM(catalog: LiteLLMCatalog, key: string): SourcedPrice | null {
  return priceFromLiteLLMSchema(catalog, key, "litellm");
}

/**
 * Look up one model's price in the CloudPrice catalog. Same schema as
 * LiteLLM. Refuses an "openrouter/"-prefixed key -- that resale tier is
 * reserved for the dedicated OpenRouter fallback, never taken via CloudPrice.
 */
function priceFromCloudPrice(catalog: CloudPriceCatalog, key: string): SourcedPrice | null {
  if (key.startsWith("openrouter/")) return null;
  return priceFromLiteLLMSchema(catalog, key, "cloudprice");
}

/** Look up one model's price in the OpenRouter catalog. Returns null if missing/unusable. */
function priceFromOpenRouter(catalog: OpenRouterCatalog, key: string): SourcedPrice | null {
  const entry = catalog.data.find((m) => m.id === key);
  if (!entry?.pricing) return null;
  const input = Number(entry.pricing.prompt);
  const output = Number(entry.pricing.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) return null;
  return {
    inputPerMtok: perTokenToPerMtok(input),
    outputPerMtok: perTokenToPerMtok(output),
    source: "openrouter",
  };
}

/**
 * Resolve one of our model ids to a sourced price: LiteLLM first, then
 * CloudPrice, then OpenRouter, else null (caller keeps the existing
 * estimate:true entry as-is).
 */
function resolvePrice(
  modelId: string,
  litellm: LiteLLMCatalog | null,
  cloudprice: CloudPriceCatalog | null,
  openrouter: OpenRouterCatalog | null,
): SourcedPrice | null {
  const map = SOURCE_MAP[modelId];
  if (!map) return null;
  if (litellm) {
    const fromLiteLLM = priceFromLiteLLM(litellm, map.litellmKey);
    if (fromLiteLLM) return fromLiteLLM;
  }
  if (cloudprice) {
    const fromCloudPrice = priceFromCloudPrice(cloudprice, map.cloudpriceKey);
    if (fromCloudPrice) return fromCloudPrice;
  }
  if (openrouter) {
    const fromOpenRouter = priceFromOpenRouter(openrouter, map.openrouterKey);
    if (fromOpenRouter) return fromOpenRouter;
  }
  return null;
}

/**
 * Pure merge step: given the current pricing.json prices, the list of model
 * ids the app ships, and the three fetched catalogs (any may be null on
 * fetch failure), produce the next `prices` map. Exported for testing without
 * any network access, pass in small inline fixture catalogs.
 */
function buildNextPrices(
  currentPrices: Record<string, ModelPrice>,
  modelIds: string[],
  litellm: LiteLLMCatalog | null,
  cloudprice: CloudPriceCatalog | null,
  openrouter: OpenRouterCatalog | null,
): { prices: Record<string, ModelPrice>; sourced: string[]; keptEstimate: string[] } {
  const prices: Record<string, ModelPrice> = { ...currentPrices };
  const sourced: string[] = [];
  const keptEstimate: string[] = [];

  for (const modelId of modelIds) {
    const resolved = resolvePrice(modelId, litellm, cloudprice, openrouter);
    if (resolved) {
      prices[modelId] = {
        inputPerMtok: resolved.inputPerMtok,
        outputPerMtok: resolved.outputPerMtok,
        currency: "USD",
        estimate: false,
        source: resolved.source,
      };
      sourced.push(modelId);
    } else {
      const existing = currentPrices[modelId];
      if (existing) {
        prices[modelId] = { ...existing, estimate: true, source: existing.source || "manual" };
      }
      keptEstimate.push(modelId);
    }
  }

  return { prices, sourced, keptEstimate };
}

/**
 * Best-effort cross-check against models.dev. Its catalog is nested
 * providers -> models with a `cost` object ALREADY in USD-per-Mtok (no
 * conversion needed). Model ids there are frequently provider-prefixed
 * ("google/gemini-3.5-flash", "alibaba/qwen3.5-plus") or bare
 * ("gemini-3.5-flash", "deepseek-v4-pro") depending on the provider entry, so
 * this matches by bare suffix: strip any "provider/" prefix from the
 * models.dev model id and compare (case-insensitively) against our
 * SOURCE_MAP's bare litellm/cloudprice key (also stripped of any
 * provider/ prefix) and against the raw modelId itself.
 *
 * Returns a list of {modelId, ourPrice, theirPrice, theirProvider} for every
 * match found whose input OR output price differs from ours by more than
 * `thresholdPct` (default 10%). Does not throw on a malformed catalog --
 * returns an empty list and lets the caller decide whether to skip.
 */
// Scans the models.dev catalog for the first usable cost entry whose bare model id matches one
// of `candidates`. Pulled out of crossCheckModelsDev so this nested-loop search scores against
// its own small function instead of inflating the caller's complexity.
function findBestModelsDevMatch(
  candidates: Set<string>,
  modelsDev: ModelsDevCatalog,
  bareOf: (id: string) => string,
): { provider: string; modelId: string; input: number; output: number } | null {
  for (const [providerId, providerData] of Object.entries(modelsDev)) {
    const models = providerData?.models;
    if (!models) continue;
    for (const [theirModelId, theirModelData] of Object.entries(models)) {
      if (!candidates.has(bareOf(theirModelId))) continue;
      const cost = theirModelData?.cost;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      if (cost.input <= 0 || cost.output <= 0) continue;
      // Prefer the first usable match; models.dev has many near-duplicate provider mirrors
      // (vercel, zenmux, etc.) that mostly agree anyway.
      return { provider: providerId, modelId: theirModelId, input: cost.input, output: cost.output };
    }
  }
  return null;
}

function crossCheckModelsDev(
  modelIds: string[],
  chainPrices: Record<string, ModelPrice>,
  modelsDev: ModelsDevCatalog,
  thresholdPct = 0.1,
): { modelId: string; ourInput: number; ourOutput: number; theirInput: number; theirOutput: number; theirProvider: string; theirModelId: string }[] {
  const mismatches: {
    modelId: string;
    ourInput: number;
    ourOutput: number;
    theirInput: number;
    theirOutput: number;
    theirProvider: string;
    theirModelId: string;
  }[] = [];

  const bareOf = (id: string): string => {
    const slash = id.lastIndexOf("/");
    return (slash === -1 ? id : id.slice(slash + 1)).toLowerCase();
  };

  for (const modelId of modelIds) {
    const ours = chainPrices[modelId];
    if (!ours || ours.estimate) continue; // nothing chosen to compare against

    const map = SOURCE_MAP[modelId];
    const candidates = new Set<string>([bareOf(modelId)]);
    if (map) {
      candidates.add(bareOf(map.litellmKey));
      candidates.add(bareOf(map.cloudpriceKey));
      candidates.add(bareOf(map.openrouterKey));
    }

    const bestMatch = findBestModelsDevMatch(candidates, modelsDev, bareOf);
    if (!bestMatch) continue;

    const inputDiff = Math.abs(bestMatch.input - ours.inputPerMtok) / ours.inputPerMtok;
    const outputDiff = Math.abs(bestMatch.output - ours.outputPerMtok) / ours.outputPerMtok;
    if (inputDiff > thresholdPct || outputDiff > thresholdPct) {
      mismatches.push({
        modelId,
        ourInput: ours.inputPerMtok,
        ourOutput: ours.outputPerMtok,
        theirInput: bestMatch.input,
        theirOutput: bestMatch.output,
        theirProvider: bestMatch.provider,
        theirModelId: bestMatch.modelId,
      });
    }
  }

  return mismatches;
}

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ! ${url} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`  ! ${url} -> ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  const todayISO = new Date().toISOString().slice(0, 10);

  console.log("-> read src/config/models.json");
  if (!existsSync(MODELS_FILE)) throw new Error(`models file not found: ${MODELS_FILE}`);
  const modelsData = readJSON<{ models?: { id: string }[] }>(MODELS_FILE, { models: [] });
  const modelIds = (modelsData.models || []).map((m) => m.id).filter(Boolean);
  console.log(`   ${modelIds.length} models: ${modelIds.join(", ")}`);

  console.log("-> fetch LiteLLM pricing catalog");
  const litellm = await fetchJSON<LiteLLMCatalog>(LITELLM_URL);
  console.log(litellm ? `   ok (${Object.keys(litellm).length} keys)` : "   FAILED, falling back to CloudPrice");

  console.log("-> fetch CloudPrice pricing catalog (fallback 1)");
  const cloudprice = await fetchJSON<CloudPriceCatalog>(CLOUDPRICE_URL);
  console.log(cloudprice ? `   ok (${Object.keys(cloudprice).length} keys)` : "   FAILED, falling back to OpenRouter");

  console.log("-> fetch OpenRouter model list (fallback 2)");
  const openrouter = await fetchJSON<OpenRouterCatalog>(OPENROUTER_URL);
  console.log(openrouter ? `   ok (${openrouter.data.length} models)` : "   FAILED");

  console.log("-> read existing src/config/pricing.json");
  const existing = readJSON<PricingFileData>(PRICING_FILE, { prices: {} });
  const currentPrices = existing.prices || {};

  console.log("-> resolve prices per model (LiteLLM -> CloudPrice -> OpenRouter -> keep estimate)");
  const { prices, sourced, keptEstimate } = buildNextPrices(currentPrices, modelIds, litellm, cloudprice, openrouter);

  const next: PricingFileData = {
    ...existing,
    _comment: existing._comment,
    lastUpdated: todayISO,
    prices,
  };
  writeJSON(PRICING_FILE, next);

  console.log(`\n-> wrote ${PRICING_FILE}`);
  console.log(`   sourced (estimate:false): ${sourced.length ? sourced.join(", ") : "(none)"}`);
  console.log(`   kept as estimate:true:    ${keptEstimate.length ? keptEstimate.join(", ") : "(none)"}`);
  for (const modelId of modelIds) {
    const p = prices[modelId];
    if (!p) {
      console.log(`   ${modelId}: (no pricing entry)`);
      continue;
    }
    console.log(
      `   ${modelId}: input=$${p.inputPerMtok}/Mtok output=$${p.outputPerMtok}/Mtok source=${p.source} estimate=${!!p.estimate}`,
    );
  }

  console.log("\n-> best-effort cross-check against models.dev");
  const modelsDev = await fetchJSON<ModelsDevCatalog>(MODELSDEV_URL);
  if (!modelsDev || typeof modelsDev !== "object") {
    console.log("   SKIPPED, models.dev fetch failed or returned an unusable shape");
  } else {
    try {
      const mismatches = crossCheckModelsDev(modelIds, prices, modelsDev);
      if (mismatches.length === 0) {
        console.log("   ok, no matched model differs by more than 10% from models.dev");
      } else {
        for (const m of mismatches) {
          console.warn(
            `   WARNING: ${m.modelId} price differs from models.dev by >10% ` +
              `(ours: $${m.ourInput}/$${m.ourOutput} per Mtok vs models.dev ${m.theirProvider}/${m.theirModelId}: ` +
              `$${m.theirInput}/$${m.theirOutput} per Mtok)`,
          );
        }
      }
    } catch (err) {
      console.log(`   SKIPPED, models.dev structure could not be mapped reliably (${(err as Error).message})`);
    }
  }
}

// Only run the network flow when executed directly (not when imported by tests).
if (import.meta.main) {
  await main();
}

export {
  perTokenToPerMtok,
  priceFromLiteLLM,
  priceFromCloudPrice,
  priceFromOpenRouter,
  resolvePrice,
  buildNextPrices,
  crossCheckModelsDev,
  SOURCE_MAP,
};
export type {
  ModelPrice,
  PricingFileData,
  LiteLLMCatalog,
  LiteLLMEntry,
  CloudPriceCatalog,
  CloudPriceEntry,
  OpenRouterCatalog,
  OpenRouterModel,
  ModelsDevCatalog,
  ModelsDevProvider,
  ModelsDevModel,
  ModelsDevCost,
  SourcedPrice,
  SourceMapEntry,
};

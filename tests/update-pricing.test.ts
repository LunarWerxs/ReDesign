// Pure-logic tests for scripts/update-pricing.ts, conversion math and
// LiteLLM-then-CloudPrice-then-OpenRouter fallback resolution, against small
// inline fixture catalogs. NO network access: the script's `main()` only
// runs when invoked directly (import.meta.main guard), so importing it here
// is side-effect-free.
import { describe, it, expect } from "bun:test";
import {
  perTokenToPerMtok,
  priceFromLiteLLM,
  priceFromCloudPrice,
  priceFromOpenRouter,
  resolvePrice,
  buildNextPrices,
  crossCheckModelsDev,
  SOURCE_MAP,
  type LiteLLMCatalog,
  type CloudPriceCatalog,
  type OpenRouterCatalog,
  type ModelsDevCatalog,
  type ModelPrice,
} from "../scripts/update-pricing";

describe("update-pricing: perTokenToPerMtok", () => {
  it("converts USD-per-token to USD-per-Mtok", () => {
    expect(perTokenToPerMtok(0.000005)).toBe(5);
    expect(perTokenToPerMtok(0.000025)).toBe(25);
    expect(perTokenToPerMtok(4.35e-7)).toBeCloseTo(0.435, 6);
  });

  it("rounds to at most 4 significant decimals without over-rounding small values", () => {
    expect(perTokenToPerMtok(2.6e-7)).toBeCloseTo(0.26, 6);
    expect(perTokenToPerMtok(1.56e-6)).toBeCloseTo(1.56, 6);
  });

  it("returns 0 for zero, negative, or non-finite input", () => {
    expect(perTokenToPerMtok(0)).toBe(0);
    expect(perTokenToPerMtok(-1)).toBe(0);
    expect(perTokenToPerMtok(NaN)).toBe(0);
    expect(perTokenToPerMtok(Infinity)).toBe(0);
  });
});

describe("update-pricing: priceFromLiteLLM", () => {
  const catalog: LiteLLMCatalog = {
    "claude-opus-4-8": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
    "dashscope/qwen3.5-plus": { tiered_pricing: [{ input_cost_per_token: 4e-7 }] } as any,
    "zero-cost-model": { input_cost_per_token: 0, output_cost_per_token: 0 },
  };

  it("resolves a model with flat per-token costs", () => {
    const price = priceFromLiteLLM(catalog, "claude-opus-4-8");
    expect(price).not.toBeNull();
    expect(price!.inputPerMtok).toBe(5);
    expect(price!.outputPerMtok).toBe(25);
    expect(price!.source).toBe("litellm");
  });

  it("returns null for a missing key", () => {
    expect(priceFromLiteLLM(catalog, "not-a-real-key")).toBeNull();
  });

  it("returns null when the entry has no flat input/output cost fields (tiered_pricing only)", () => {
    expect(priceFromLiteLLM(catalog, "dashscope/qwen3.5-plus")).toBeNull();
  });

  it("returns null for a zero-cost entry (treated as unusable, not free)", () => {
    expect(priceFromLiteLLM(catalog, "zero-cost-model")).toBeNull();
  });
});

describe("update-pricing: priceFromCloudPrice", () => {
  const catalog: CloudPriceCatalog = {
    "dashscope/qwen3.5-plus": { input_cost_per_token: 4e-7, output_cost_per_token: 2.4e-6 },
    "openrouter/qwen/qwen3.5-plus-02-15": { input_cost_per_token: 2.6e-7, output_cost_per_token: 1.56e-6 },
    "zero-cost-model": { input_cost_per_token: 0, output_cost_per_token: 0 },
  };

  it("resolves a direct-provider entry (e.g. dashscope/) with flat per-token costs", () => {
    const price = priceFromCloudPrice(catalog, "dashscope/qwen3.5-plus");
    expect(price).not.toBeNull();
    expect(price!.inputPerMtok).toBeCloseTo(0.4, 6);
    expect(price!.outputPerMtok).toBeCloseTo(2.4, 6);
    expect(price!.source).toBe("cloudprice");
  });

  it("NEVER takes an openrouter/-prefixed entry from CloudPrice, even if present and usable", () => {
    expect(priceFromCloudPrice(catalog, "openrouter/qwen/qwen3.5-plus-02-15")).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(priceFromCloudPrice(catalog, "not-a-real-key")).toBeNull();
  });

  it("returns null for a zero-cost entry (treated as unusable, not free)", () => {
    expect(priceFromCloudPrice(catalog, "zero-cost-model")).toBeNull();
  });
});

describe("update-pricing: priceFromOpenRouter", () => {
  const catalog: OpenRouterCatalog = {
    data: [
      { id: "qwen/qwen3.5-plus-02-15", pricing: { prompt: "0.00000026", completion: "0.00000156" } },
      { id: "no-pricing-model" },
      { id: "bad-pricing-model", pricing: { prompt: "not-a-number", completion: "0.000001" } },
    ],
  };

  it("resolves a model with string USD-per-token pricing", () => {
    const price = priceFromOpenRouter(catalog, "qwen/qwen3.5-plus-02-15");
    expect(price).not.toBeNull();
    expect(price!.inputPerMtok).toBeCloseTo(0.26, 6);
    expect(price!.outputPerMtok).toBeCloseTo(1.56, 6);
    expect(price!.source).toBe("openrouter");
  });

  it("returns null for a missing id", () => {
    expect(priceFromOpenRouter(catalog, "not-a-real-id")).toBeNull();
  });

  it("returns null when pricing is absent", () => {
    expect(priceFromOpenRouter(catalog, "no-pricing-model")).toBeNull();
  });

  it("returns null when pricing fields aren't parseable numbers", () => {
    expect(priceFromOpenRouter(catalog, "bad-pricing-model")).toBeNull();
  });
});

describe("update-pricing: resolvePrice (LiteLLM -> CloudPrice -> OpenRouter fallback)", () => {
  it("prefers LiteLLM when all three sources have the model", () => {
    const litellm: LiteLLMCatalog = {
      "claude-opus-4-8": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
    };
    const cloudprice: CloudPriceCatalog = {
      "claude-opus-4-8": { input_cost_per_token: 0.0000088, output_cost_per_token: 0.0000888 },
    };
    const openrouter: OpenRouterCatalog = {
      data: [{ id: "anthropic/claude-opus-4.8", pricing: { prompt: "0.0000099", completion: "0.0000999" } }],
    };
    const price = resolvePrice("claude-opus-4-8", litellm, cloudprice, openrouter);
    expect(price!.source).toBe("litellm");
    expect(price!.inputPerMtok).toBe(5);
  });

  it("falls back to CloudPrice when LiteLLM is missing the model (qwen-3.5-plus case)", () => {
    const litellm: LiteLLMCatalog = {
      "dashscope/qwen3.5-plus": { tiered_pricing: [] } as any, // no flat cost fields
    };
    const cloudprice: CloudPriceCatalog = {
      "dashscope/qwen3.5-plus": { input_cost_per_token: 4e-7, output_cost_per_token: 2.4e-6 },
    };
    const openrouter: OpenRouterCatalog = {
      data: [{ id: "qwen/qwen3.5-plus-02-15", pricing: { prompt: "0.00000026", completion: "0.00000156" } }],
    };
    const price = resolvePrice("qwen-3.5-plus", litellm, cloudprice, openrouter);
    expect(price).not.toBeNull();
    expect(price!.source).toBe("cloudprice");
    expect(price!.inputPerMtok).toBeCloseTo(0.4, 6);
    expect(price!.outputPerMtok).toBeCloseTo(2.4, 6);
  });

  it("falls back to OpenRouter when both LiteLLM and CloudPrice are missing the model", () => {
    const litellm: LiteLLMCatalog = {};
    const cloudprice: CloudPriceCatalog = {
      "dashscope/qwen3.5-plus": { tiered_pricing: [] } as any, // no flat cost fields, same as LiteLLM
    };
    const openrouter: OpenRouterCatalog = {
      data: [{ id: "qwen/qwen3.5-plus-02-15", pricing: { prompt: "0.00000026", completion: "0.00000156" } }],
    };
    const price = resolvePrice("qwen-3.5-plus", litellm, cloudprice, openrouter);
    expect(price).not.toBeNull();
    expect(price!.source).toBe("openrouter");
    expect(price!.inputPerMtok).toBeCloseTo(0.26, 6);
  });

  it("never takes CloudPrice's openrouter/-prefixed entries even as a 'last resort' before OpenRouter", () => {
    const cloudprice: CloudPriceCatalog = {
      "openrouter/qwen/qwen3.5-plus-02-15": { input_cost_per_token: 2.6e-7, output_cost_per_token: 1.56e-6 },
    };
    // SOURCE_MAP's cloudpriceKey for qwen is the direct "dashscope/..." key, so this
    // fixture catalog (only holding the openrouter/-prefixed key) must resolve to null
    // via CloudPrice regardless, falling through to the OpenRouter catalog.
    const openrouter: OpenRouterCatalog = {
      data: [{ id: "qwen/qwen3.5-plus-02-15", pricing: { prompt: "0.00000026", completion: "0.00000156" } }],
    };
    const price = resolvePrice("qwen-3.5-plus", null, cloudprice, openrouter);
    expect(price!.source).toBe("openrouter");
  });

  it("returns null when the model isn't in SOURCE_MAP at all", () => {
    expect(resolvePrice("not-a-shipped-model", {}, {}, { data: [] })).toBeNull();
  });

  it("returns null when none of the three sources have the model", () => {
    expect(resolvePrice("claude-opus-4-8", {}, {}, { data: [] })).toBeNull();
  });

  it("handles null catalogs (fetch failure) without throwing", () => {
    expect(resolvePrice("claude-opus-4-8", null, null, null)).toBeNull();
  });

  it("SOURCE_MAP covers exactly the 6 shipped models", () => {
    expect(Object.keys(SOURCE_MAP).sort()).toEqual(
      ["claude-opus-4-8", "gpt-5.5", "gemini-3.5-flash", "gemini-3.1-pro", "deepseek-v4-pro", "qwen-3.5-plus"].sort(),
    );
  });
});

describe("update-pricing: buildNextPrices", () => {
  const currentPrices: Record<string, ModelPrice> = {
    "claude-opus-4-8": { inputPerMtok: 15, outputPerMtok: 75, currency: "USD", estimate: true },
    "totally-unmapped-model": { inputPerMtok: 1, outputPerMtok: 2, currency: "USD", estimate: true },
  };

  it("marks a successfully-sourced model estimate:false with its source", () => {
    const litellm: LiteLLMCatalog = {
      "claude-opus-4-8": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
    };
    const { prices, sourced, keptEstimate } = buildNextPrices(currentPrices, ["claude-opus-4-8"], litellm, null, null);
    expect(sourced).toEqual(["claude-opus-4-8"]);
    expect(keptEstimate).toEqual([]);
    expect(prices["claude-opus-4-8"]).toEqual({
      inputPerMtok: 5,
      outputPerMtok: 25,
      currency: "USD",
      estimate: false,
      source: "litellm",
    });
  });

  it("keeps a model's existing entry as estimate:true when none of the three sources have it", () => {
    const { prices, sourced, keptEstimate } = buildNextPrices(
      currentPrices,
      ["totally-unmapped-model"],
      {},
      {},
      { data: [] },
    );
    expect(sourced).toEqual([]);
    expect(keptEstimate).toEqual(["totally-unmapped-model"]);
    expect(prices["totally-unmapped-model"]).toMatchObject({ inputPerMtok: 1, outputPerMtok: 2, estimate: true });
  });

  it("does not fabricate an entry for a model with no SOURCE_MAP and no prior pricing", () => {
    const { prices, keptEstimate } = buildNextPrices({}, ["brand-new-model"], {}, {}, { data: [] });
    expect(keptEstimate).toEqual(["brand-new-model"]);
    expect(prices["brand-new-model"]).toBeUndefined();
  });

  it("processes all 6 real model ids together without throwing (integration-style, still no network)", () => {
    const litellm: LiteLLMCatalog = {
      "claude-opus-4-8": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
      "gpt-5.5": { input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
      "gemini-3.5-flash": { input_cost_per_token: 0.0000015, output_cost_per_token: 0.000009 },
      "gemini-3.1-pro-preview": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
      "deepseek-v4-pro": { input_cost_per_token: 4.35e-7, output_cost_per_token: 8.7e-7 },
      "dashscope/qwen3.5-plus": {} as any, // LiteLLM: no flat cost fields
    };
    const cloudprice: CloudPriceCatalog = {
      "dashscope/qwen3.5-plus": { input_cost_per_token: 4e-7, output_cost_per_token: 2.4e-6 },
    };
    const openrouter: OpenRouterCatalog = {
      data: [{ id: "qwen/qwen3.5-plus-02-15", pricing: { prompt: "0.00000026", completion: "0.00000156" } }],
    };
    const modelIds = ["claude-opus-4-8", "gpt-5.5", "gemini-3.5-flash", "gemini-3.1-pro", "deepseek-v4-pro", "qwen-3.5-plus"];
    const { prices, sourced, keptEstimate } = buildNextPrices({}, modelIds, litellm, cloudprice, openrouter);
    expect(sourced.sort()).toEqual([...modelIds].sort());
    expect(keptEstimate).toEqual([]);
    expect(prices["qwen-3.5-plus"]!.source).toBe("cloudprice");
    // Flash-class model must be far cheaper than opus-class, sanity per the task's ask.
    expect(prices["gemini-3.5-flash"]!.inputPerMtok).toBeLessThan(prices["claude-opus-4-8"]!.inputPerMtok);
    expect(prices["gemini-3.5-flash"]!.outputPerMtok).toBeLessThan(prices["claude-opus-4-8"]!.outputPerMtok);
    for (const modelId of modelIds) {
      expect(prices[modelId]!.inputPerMtok).toBeGreaterThan(0);
      expect(prices[modelId]!.outputPerMtok).toBeGreaterThan(0);
      expect(Number.isNaN(prices[modelId]!.inputPerMtok)).toBe(false);
      expect(Number.isNaN(prices[modelId]!.outputPerMtok)).toBe(false);
    }
  });
});

describe("update-pricing: crossCheckModelsDev", () => {
  const modelIds = ["claude-opus-4-8", "qwen-3.5-plus"];

  it("returns no mismatch when models.dev agrees within 10%", () => {
    const chainPrices: Record<string, ModelPrice> = {
      "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, currency: "USD", estimate: false, source: "litellm" },
    };
    const modelsDev: ModelsDevCatalog = {
      vercel: { models: { "anthropic/claude-opus-4.8": { cost: { input: 5, output: 25 } } } },
    };
    const mismatches = crossCheckModelsDev(["claude-opus-4-8"], chainPrices, modelsDev);
    expect(mismatches).toEqual([]);
  });

  it("flags a >10% mismatch and names both numbers", () => {
    const chainPrices: Record<string, ModelPrice> = {
      "qwen-3.5-plus": { inputPerMtok: 0.4, outputPerMtok: 2.4, currency: "USD", estimate: false, source: "cloudprice" },
    };
    const modelsDev: ModelsDevCatalog = {
      "alibaba-cn": { models: { "qwen3.5-plus": { cost: { input: 0.573, output: 3.44 } } } },
    };
    const mismatches = crossCheckModelsDev(["qwen-3.5-plus"], chainPrices, modelsDev);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      modelId: "qwen-3.5-plus",
      ourInput: 0.4,
      ourOutput: 2.4,
      theirInput: 0.573,
      theirOutput: 3.44,
      theirProvider: "alibaba-cn",
    });
  });

  it("skips a model that was kept as estimate (nothing chosen to compare against)", () => {
    const chainPrices: Record<string, ModelPrice> = {
      "claude-opus-4-8": { inputPerMtok: 999, outputPerMtok: 999, currency: "USD", estimate: true },
    };
    const modelsDev: ModelsDevCatalog = {
      vercel: { models: { "anthropic/claude-opus-4.8": { cost: { input: 5, output: 25 } } } },
    };
    expect(crossCheckModelsDev(["claude-opus-4-8"], chainPrices, modelsDev)).toEqual([]);
  });

  it("skips a model with no matching entry anywhere in models.dev", () => {
    const chainPrices: Record<string, ModelPrice> = {
      "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, currency: "USD", estimate: false, source: "litellm" },
    };
    const modelsDev: ModelsDevCatalog = { somewhere: { models: { "totally-unrelated-model": { cost: { input: 1, output: 2 } } } } };
    expect(crossCheckModelsDev(["claude-opus-4-8"], chainPrices, modelsDev)).toEqual([]);
  });

  it("does not throw on malformed/missing models/cost fields", () => {
    const chainPrices: Record<string, ModelPrice> = {
      "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, currency: "USD", estimate: false, source: "litellm" },
    };
    const modelsDev = {
      brokenProvider: {},
      anotherProvider: { models: { "claude-opus-4-8": {} } },
      thirdProvider: { models: { "claude-opus-4-8": { cost: { input: "not-a-number" } } } },
    } as unknown as ModelsDevCatalog;
    expect(() => crossCheckModelsDev(modelIds, chainPrices, modelsDev)).not.toThrow();
    expect(crossCheckModelsDev(modelIds, chainPrices, modelsDev)).toEqual([]);
  });
});

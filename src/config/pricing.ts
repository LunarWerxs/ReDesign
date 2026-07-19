// Per-model list pricing (src/config/pricing.json) for the Run Cost Meter. Same
// mtime-cached read as models.json/prompts.json (see config/shared.ts readConfig).

import { PRICING_FILE, readConfig } from "./shared";

interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  currency: string;
  estimate?: boolean;
  source?: "litellm" | "cloudprice" | "openrouter" | "manual"; // where the price came from (see scripts/update-pricing.ts)
}

interface PricingFileData {
  lastUpdated?: string;
  prices: Record<string, ModelPrice>;
  [key: string]: unknown;
}

const EMPTY: PricingFileData = { lastUpdated: undefined, prices: {} };

function loadPricing(): PricingFileData {
  return readConfig<PricingFileData>(PRICING_FILE, EMPTY);
}

function priceForModel(modelId: string): ModelPrice | null {
  const data = loadPricing();
  return (data.prices?.[modelId]) || null;
}

function pricingLastUpdated(): string | null {
  return loadPricing().lastUpdated || null;
}

export { loadPricing, priceForModel, pricingLastUpdated };
export type { ModelPrice, PricingFileData };

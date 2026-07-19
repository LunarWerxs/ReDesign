import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import * as store from "../src/store";
import { normalizeUsage, costForUsage, runCost, spendToDate, averageUsageByModel, estimateRunCost } from "../src/runner/cost";
import { loadPricing, priceForModel, pricingLastUpdated } from "../src/config/pricing";

const KNOWN_MODEL = "claude-opus-4-8"; // present in src/config/pricing.json
const UNPRICED_MODEL = "not-a-real-model-id";

describe("cost: pricing table loading", () => {
  it("loads pricing.json with a lastUpdated stamp and priced entries", () => {
    const data = loadPricing();
    expect(typeof data.lastUpdated).toBe("string");
    expect(Object.keys(data.prices).length).toBeGreaterThan(0);
  });

  it("priceForModel returns a priced entry for a known model id", () => {
    const price = priceForModel(KNOWN_MODEL);
    expect(price).not.toBeNull();
    expect(price!.inputPerMtok).toBeGreaterThan(0);
    expect(price!.outputPerMtok).toBeGreaterThan(0);
    expect(price!.currency).toBe("USD");
  });

  it("priceForModel returns null for an unknown model id", () => {
    expect(priceForModel(UNPRICED_MODEL)).toBeNull();
  });

  it("pricingLastUpdated matches the top-level lastUpdated field", () => {
    expect(pricingLastUpdated()).toBe(loadPricing().lastUpdated || null);
  });
});

describe("cost: normalizeUsage across provider shapes", () => {
  it("normalizes Anthropic usage shape", () => {
    expect(normalizeUsage({ input_tokens: 100, output_tokens: 200 })).toEqual({ inputTokens: 100, outputTokens: 200 });
  });

  it("normalizes OpenAI-compatible usage shape", () => {
    expect(normalizeUsage({ prompt_tokens: 150, completion_tokens: 300, total_tokens: 450 })).toEqual({
      inputTokens: 150,
      outputTokens: 300,
    });
  });

  it("normalizes Gemini usage shape", () => {
    expect(normalizeUsage({ promptTokenCount: 80, candidatesTokenCount: 120, totalTokenCount: 200 })).toEqual({
      inputTokens: 80,
      outputTokens: 120,
    });
  });

  it("normalizes the mock adapter's usage shape", () => {
    expect(normalizeUsage({ mock: true, input_tokens: 0, output_tokens: 500 })).toEqual({ inputTokens: 0, outputTokens: 500 });
  });

  it("returns zeros for null/missing/malformed usage", () => {
    expect(normalizeUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage("not an object")).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("cost: costForUsage math", () => {
  it("prices a known model's Anthropic-shaped usage correctly", () => {
    const price = priceForModel(KNOWN_MODEL)!;
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const breakdown = costForUsage(KNOWN_MODEL, usage);
    expect(breakdown.priced).toBe(true);
    expect(breakdown.inputCost).toBeCloseTo(price.inputPerMtok, 6);
    expect(breakdown.outputCost).toBeCloseTo(price.outputPerMtok, 6);
    expect(breakdown.totalCost).toBeCloseTo(price.inputPerMtok + price.outputPerMtok, 6);
    expect(breakdown.estimate).toBe(!!price.estimate);
  });

  it("prices OpenAI-shaped usage for a known model the same as the equivalent Anthropic shape", () => {
    const a = costForUsage(KNOWN_MODEL, { input_tokens: 2000, output_tokens: 4000 });
    const b = costForUsage(KNOWN_MODEL, { prompt_tokens: 2000, completion_tokens: 4000 });
    expect(b.totalCost).toBeCloseTo(a.totalCost, 10);
  });

  it("prices Gemini-shaped usage for a known model the same as the equivalent Anthropic shape", () => {
    const a = costForUsage(KNOWN_MODEL, { input_tokens: 500, output_tokens: 1500 });
    const b = costForUsage(KNOWN_MODEL, { promptTokenCount: 500, candidatesTokenCount: 1500 });
    expect(b.totalCost).toBeCloseTo(a.totalCost, 10);
  });

  it("returns priced=false and zero cost for a model with no pricing entry", () => {
    const breakdown = costForUsage(UNPRICED_MODEL, { input_tokens: 1000, output_tokens: 1000 });
    expect(breakdown.priced).toBe(false);
    expect(breakdown.totalCost).toBe(0);
  });

  it("returns zero cost for zero usage on a priced model (not the same as unpriced)", () => {
    const breakdown = costForUsage(KNOWN_MODEL, { input_tokens: 0, output_tokens: 0 });
    expect(breakdown.priced).toBe(true);
    expect(breakdown.totalCost).toBe(0);
  });
});

describe("cost: runCost aggregates a manifest's jobs", () => {
  it("sums cost only across jobs carrying usage, and tags anyUnpriced", () => {
    const manifest = {
      jobs: [
        { modelId: KNOWN_MODEL, usage: { input_tokens: 1000, output_tokens: 1000 } },
        { modelId: KNOWN_MODEL, usage: { input_tokens: 1000, output_tokens: 1000 } },
        { modelId: UNPRICED_MODEL, usage: { input_tokens: 1000, output_tokens: 1000 } },
        { modelId: KNOWN_MODEL, usage: null }, // no usage yet (still running/pending), excluded
      ],
    };
    const result = runCost(manifest);
    expect(result.jobCount).toBe(3);
    expect(result.anyUnpriced).toBe(true);
    expect(result.byModel[KNOWN_MODEL]!.totalCost).toBeGreaterThan(0);
    expect(result.byModel[UNPRICED_MODEL]!.totalCost).toBe(0);
  });

  it("returns a zeroed result for a manifest with no jobs", () => {
    expect(runCost({ jobs: [] })).toMatchObject({ totalCost: 0, jobCount: 0 });
    expect(runCost(null)).toMatchObject({ totalCost: 0, jobCount: 0 });
    expect(runCost(undefined)).toMatchObject({ totalCost: 0, jobCount: 0 });
  });
});

describe("cost: spendToDate + estimateRunCost use real stored runs", () => {
  const runId = `20990101-000002-costtest-${process.pid}`;

  afterAll(() => {
    try {
      fs.rmSync(store.runDir(runId), { recursive: true, force: true });
    } catch (_) {}
  });

  it("spendToDate sums cost across stored runs and surfaces pricingLastUpdated", () => {
    store.writeManifest(runId, {
      runId,
      status: "done",
      counts: { total: 1, done: 1, ok: 1, error: 0, skipped: 0 },
      cost: { totalCost: 1.23, currency: "USD", jobCount: 1, anyEstimatePricing: true, anyUnpriced: false },
      inputs: [],
      prompts: [],
      models: [],
      jobs: [],
    } as store.Manifest);

    const result = spendToDate({ activeRunIds: [] });
    expect(result.totalCost).toBeGreaterThanOrEqual(1.23);
    expect(result.runCount).toBeGreaterThanOrEqual(1);
    expect(result.anyEstimatePricing).toBe(true);
    expect(result.pricingLastUpdated).toBe(pricingLastUpdated());
  });

  it("estimateRunCost falls back to the documented default when a model has no run history", () => {
    const neverRunModel = "model-with-zero-history";
    const result = estimateRunCost({ modelIds: [neverRunModel], jobCount: 4 }, { activeRunIds: [] });
    expect(result.anyFromDefault).toBe(true);
    expect(result.byModel[neverRunModel]!.fromHistory).toBe(false);
    // Unpriced (no pricing.json entry for this made-up id) => zero cost, but the
    // estimate path must still run without throwing and must still flag it.
    expect(result.anyUnpriced).toBe(true);
    expect(result.byModel[neverRunModel]!.totalCost).toBe(0);
  });

  it("estimateRunCost uses averaged historical usage when a model has completed runs", () => {
    // A model id unique to this test (not KNOWN_MODEL) so the average isn't polluted
    // by real runs already sitting in output/ from actual app usage.
    const historyModel = `cost-test-model-${process.pid}`;
    const historyRunId = `20990101-000003-costhist-${process.pid}`;
    store.writeManifest(historyRunId, {
      runId: historyRunId,
      status: "done",
      counts: { total: 1, done: 1, ok: 1, error: 0, skipped: 0 },
      inputs: [],
      prompts: [],
      models: [],
      jobs: [
        { id: "j1", modelId: historyModel, status: "ok", usage: { input_tokens: 2000, output_tokens: 8000 } },
        { id: "j2", modelId: historyModel, status: "ok", usage: { input_tokens: 4000, output_tokens: 12000 } },
      ],
    } as store.Manifest);
    try {
      const averages = averageUsageByModel([historyModel], { activeRunIds: [] });
      const avg = averages[historyModel]!;
      expect(avg.fromHistory).toBe(true);
      expect(avg.inputTokens).toBeCloseTo(3000, 5);
      expect(avg.outputTokens).toBeCloseTo(10000, 5);

      // historyModel has no pricing.json entry, so cost is 0 (priced:false), the
      // point of this assertion is the averaging math above, not the dollar amount.
      const result = estimateRunCost({ modelIds: [historyModel], jobCount: 2 }, { activeRunIds: [] });
      expect(result.byModel[historyModel]!.fromHistory).toBe(true);
      expect(result.anyUnpriced).toBe(true);
    } finally {
      fs.rmSync(store.runDir(historyRunId), { recursive: true, force: true });
    }
  });
});

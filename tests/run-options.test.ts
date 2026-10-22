import { expect, test } from "bun:test";
import { buildMcpRunBody, parseMaxCostUsd, parseModelQuantities } from "../src/run-options";

test("model quantities accept only complete positive integer assignments", () => {
  expect(parseModelQuantities("gpt=2, claude=1")).toEqual({ gpt: 2, claude: 1 });
  for (const value of ["gpt", "=2", "gpt=0", "gpt=-1", "gpt=1.5", "gpt=2x", "gpt=1,gpt=2"]) {
    expect(() => parseModelQuantities(value)).toThrow("model quantities");
  }
});

test("max cost accepts a finite nonnegative number and rejects malformed values", () => {
  expect(parseMaxCostUsd("12.50")).toBe(12.5);
  expect(parseMaxCostUsd(undefined)).toBeUndefined();
  for (const value of ["", "-1", "Infinity", true]) expect(() => parseMaxCostUsd(value)).toThrow("max cost");
});

test("MCP run body preserves existing defaults and carries a validated budget", () => {
  expect(buildMcpRunBody({ custom: "one off", max_cost: "2.5" })).toEqual({
    inputs: "all",
    models: "all",
    prompts: { presets: [], custom: "one off" },
    reference: null,
    variants: 1,
    modelQuantities: undefined,
    brandStyleGuide: null,
    mock: false,
    concurrency: undefined,
    maxImages: undefined,
    label: undefined,
    maxCostUsd: 2.5,
  });
});

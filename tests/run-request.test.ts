import { describe, expect, it } from "bun:test";
import { validateRunRequest } from "../src/http/run-request";

describe("run request admission", () => {
  it("does not mistake an explicit preset named all for the all-presets selector", () => {
    expect(() => validateRunRequest({ prompts: { presets: ["all"] } })).toThrow("unknown prompt preset");
    expect(() => validateRunRequest({ prompts: { presets: "all, " } })).toThrow("unknown prompt preset");
    expect(validateRunRequest({ prompts: { presets: "all" } })).toEqual({ prompts: { presets: "all" } });
  });
  it("rejects malformed request values before they can use default selections", () => {
    for (const body of [null, [], "not an object"]) {
      expect(() => validateRunRequest(body)).toThrow("request body must be a JSON object");
    }
  });

  it("rejects explicit unknown model and preset selections", () => {
    expect(() => validateRunRequest({ inputs: { ids: ["missing-input"] } })).toThrow("unknown input");
    expect(() => validateRunRequest({ models: { ids: ["missing-model"] } })).toThrow("unknown model");
    expect(() => validateRunRequest({ prompts: { presets: ["missing-preset"] } })).toThrow("unknown prompt preset");
  });

  it("rejects scalar selectors and prompt shapes the resolver cannot use", () => {
    expect(() => validateRunRequest({ inputs: 1 })).toThrow("invalid input selection");
    expect(() => validateRunRequest({ models: true })).toThrow("invalid model selection");
    expect(() => validateRunRequest({ prompts: { presets: { ids: ["minimalist"] } } })).toThrow("invalid prompt preset selection");
  });

  it("allows the normal one-off custom recipe with an empty preset list", () => {
    expect(validateRunRequest({ prompts: { presets: [], custom: "one-off" } })).toEqual({ prompts: { presets: [], custom: "one-off" } });
  });

  it("keeps omitted selections available for intentional defaults", () => {
    expect(validateRunRequest({ autoStart: false })).toEqual({ autoStart: false });
  });
});

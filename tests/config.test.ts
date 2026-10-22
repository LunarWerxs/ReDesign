import { describe, expect, it } from "bun:test";
import * as config from "../src/config";

describe("config: model & prompt resolution", () => {
  it('resolveModels("all") returns enabled models', () => {
    expect(config.resolveModels("all").length).toBeGreaterThanOrEqual(1);
  });

  it("resolveModels by id", () => {
    expect(config.resolveModels({ ids: ["deepseek-4.1-flash"] }).map((m) => m.id)).toEqual(["deepseek-4.1-flash"]);
  });

  it("resolvePrompts includes preset + custom", () => {
    const pr = config.resolvePrompts({ presets: ["minimalist"], custom: "make it pink" });
    expect(pr.length).toBe(2);
    expect(pr.some((p) => p.id === "custom")).toBe(true);
    expect(pr.some((p) => p.id === "minimalist")).toBe(true);
  });

  it("resolvePrompts falls back when empty", () => {
    expect(config.resolvePrompts({}).length).toBe(1);
  });

  it("resolvePrompts does not replace an unknown explicit preset with the default", () => {
    expect(() => config.resolvePrompts({ presets: ["deleted-preset"] })).toThrow("unknown prompt preset");
    expect(() => config.resolvePrompts({ presets: ["deleted-preset"], custom: "one-off" })).toThrow("unknown prompt preset");
  });

  it("resolvePrompts deduplicates repeated presets and gives one-off custom text a reserved id", () => {
    const prompts = config.resolvePrompts({ presets: ["minimalist", "minimalist"], custom: "make it pink" });
    expect(prompts.map((prompt) => prompt.id)).toEqual(["minimalist", "custom"]);
  });

  it("gives one-off custom text a filesystem-safe id when a saved Custom preset is selected", () => {
    const saved = config.savePromptPreset({ label: "Custom", user: "saved prompt" });
    try {
      const prompts = config.resolvePrompts({ presets: [saved.id], custom: "one-off prompt" });
      expect(prompts.map((prompt) => prompt.id)).toEqual(["custom", "custom-2"]);
      expect(prompts.every((prompt) => /^[a-z0-9-]+$/.test(prompt.id))).toBe(true);
    } finally {
      config.deletePromptPreset(saved.id);
    }
  });

  it("material-3 + approachable + minimalist-two presets are present", () => {
    const allPrompts = config.loadPrompts().prompts;
    expect(allPrompts.find((p) => p.id === "material-3")?.pickerHidden).toBe(true);
    expect(allPrompts.some((p) => p.id === "approachable")).toBe(true);
    expect(allPrompts.some((p) => p.id === "minimalist-two")).toBe(true);
  });
});

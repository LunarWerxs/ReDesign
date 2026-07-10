import { describe, it, expect } from "bun:test";
import * as config from "../src/config";

describe("config: model & prompt resolution", () => {
  it('resolveModels("all") returns enabled models', () => {
    expect(config.resolveModels("all").length).toBeGreaterThanOrEqual(1);
  });

  it("resolveModels by id", () => {
    expect(config.resolveModels({ ids: ["deepseek-v4-pro"] }).map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
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

  it("material-3 + approachable + minimalist-two presets are present", () => {
    const allPrompts = config.loadPrompts().prompts;
    expect(allPrompts.some((p) => p.id === "material-3")).toBe(true);
    expect(allPrompts.some((p) => p.id === "approachable")).toBe(true);
    expect(allPrompts.some((p) => p.id === "minimalist-two")).toBe(true);
  });
});

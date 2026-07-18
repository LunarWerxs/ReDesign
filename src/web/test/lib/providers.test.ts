import { describe, it, expect } from "vitest";
import { PROVIDER_LABELS, providerLabel, providerOptions, OPENAI_FAMILY } from "@/lib/providers";

describe("providerLabel", () => {
  it("maps a known provider id to its display name", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai-compatible")).toBe("OpenAI-compatible");
  });

  it("matches case-insensitively", () => {
    expect(providerLabel("OpenAI")).toBe("OpenAI");
    expect(providerLabel("ANTHROPIC")).toBe("Anthropic");
  });

  it("passes an unknown provider through rather than blanking it", () => {
    // Better to surface a raw id in the UI than an empty label.
    expect(providerLabel("some-new-vendor")).toBe("some-new-vendor");
  });

  it("yields an empty string for absent input", () => {
    expect(providerLabel(undefined)).toBe("");
    expect(providerLabel("")).toBe("");
  });

  it("aliases google and gemini to the same vendor", () => {
    expect(providerLabel("google")).toBe(providerLabel("gemini"));
  });
});

describe("provider registry consistency", () => {
  it("gives every selectable option a label", () => {
    // A picker entry with no PROVIDER_LABELS row would render blank once selected.
    for (const opt of providerOptions) {
      expect(PROVIDER_LABELS[opt.value], `no label for option "${opt.value}"`).toBeDefined();
    }
  });

  it("gives every OpenAI-family member a label", () => {
    for (const id of OPENAI_FAMILY) {
      expect(PROVIDER_LABELS[id], `no label for family member "${id}"`).toBeDefined();
    }
  });

  it("uses lowercase keys throughout, since providerLabel lowercases before lookup", () => {
    for (const key of Object.keys(PROVIDER_LABELS)) {
      expect(key).toBe(key.toLowerCase());
    }
    for (const opt of providerOptions) {
      expect(opt.value).toBe(opt.value.toLowerCase());
    }
  });

  it("excludes the non-OpenAI vendors from the family set", () => {
    // The family set gates the tokenParam field, so a stray member changes the model editor.
    expect(OPENAI_FAMILY.has("anthropic")).toBe(false);
    expect(OPENAI_FAMILY.has("gemini")).toBe(false);
    expect(OPENAI_FAMILY.has("google")).toBe(false);
  });

  it("includes the OpenAI-compatible vendors in the family set", () => {
    expect(OPENAI_FAMILY.has("openai")).toBe(true);
    expect(OPENAI_FAMILY.has("openai-compatible")).toBe(true);
    expect(OPENAI_FAMILY.has("deepseek")).toBe(true);
  });
});

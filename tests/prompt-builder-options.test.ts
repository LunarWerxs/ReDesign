import { describe, expect, it } from "bun:test";
import {
  normalizePromptBuilderRecipe,
  normalizeStoredPromptBuilderOptions,
  removePromptBuilderOption,
  upsertPromptBuilderOption,
} from "../src/config/prompts";
import { createApp } from "../src/http/app";

describe("prompt builder option library", () => {
  it("creates stable namespaced ids without coupling to the built-in registry", () => {
    const first = upsertPromptBuilderOption([], {
      label: "Material 3",
      description: "My take on Material",
      instruction: "Use our product team's Material-inspired visual system.",
      category: "design",
    });
    expect(first.builderOption).toEqual({
      id: "custom-material-3",
      label: "Material 3",
      description: "My take on Material",
      instruction: "Use our product team's Material-inspired visual system.",
      category: "design",
    });

    const second = upsertPromptBuilderOption(first.builderOptions, {
      label: "Material 3",
      instruction: "Use a different house style.",
      category: "design",
    });
    expect(second.builderOption.id).toBe("custom-material-3-2");
  });

  it("updates in place without changing id or list order", () => {
    const initial = [
      {
        id: "compact-navigation",
        label: "Compact navigation",
        instruction: "Keep navigation compact.",
        category: "structure" as const,
      },
      {
        id: "house-colors",
        label: "House colors",
        instruction: "Use the house color system.",
        category: "design" as const,
      },
    ];
    const result = upsertPromptBuilderOption(initial, {
      id: "compact-navigation",
      label: "Compact navigation",
      description: "For information-dense tools",
      instruction: "Use compact, progressively disclosed navigation.",
      category: "structure",
    });

    expect(result.builderOption.id).toBe("compact-navigation");
    expect(result.builderOptions.map((option) => option.id)).toEqual([
      "compact-navigation",
      "house-colors",
    ]);
    expect(result.builderOptions[0]?.description).toBe("For information-dense tools");
  });

  it("validates required text, categories, and unknown updates", () => {
    expect(() =>
      upsertPromptBuilderOption([], {
        label: "No instruction",
        category: "design",
      }),
    ).toThrow("instruction is required");
    expect(() =>
      upsertPromptBuilderOption([], {
        label: "Wrong category",
        instruction: "Do something.",
        category: "behavior",
      }),
    ).toThrow("category must be structure or design");
    expect(() =>
      upsertPromptBuilderOption([], {
        id: "missing",
        label: "Missing",
        instruction: "Do something.",
        category: "structure",
      }),
    ).toThrow("prompt builder option not found");
  });

  it("normalizes persisted data with stable order and unique safe ids", () => {
    const options = normalizeStoredPromptBuilderOptions([
      {
        id: "density",
        label: "Density",
        instruction: "Use compact density.",
        category: "structure",
      },
      {
        id: "density",
        label: "Duplicate",
        instruction: "This duplicate should be ignored.",
        category: "design",
      },
      {
        id: "unsafe id",
        label: "Unsafe id",
        instruction: "This invalid id should be ignored.",
        category: "design",
      },
      { id: "invalid", label: "", instruction: "", category: "other" },
      {
        id: "brand-tone",
        label: "Brand tone",
        description: "A recognizable visual voice",
        instruction: "Use the brand's distinct visual tone.",
        category: "design",
      },
    ]);

    expect(options.map((option) => option.id)).toEqual(["density", "brand-tone"]);
  });

  it("keeps bookmark snapshots intact after deleting the library option", () => {
    const saved = upsertPromptBuilderOption([], {
      label: "Dense data",
      instruction: "Favor compact tables and information-dense layouts.",
      category: "structure",
    });
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: "balanced",
      modifiers: ["minimal"],
      customOptions: [saved.builderOption],
    });
    const libraryAfterDelete = removePromptBuilderOption(
      saved.builderOptions,
      saved.builderOption.id,
    );

    expect(libraryAfterDelete.builderOptions).toEqual([]);
    expect(recipe?.customOptions).toEqual([saved.builderOption]);
  });

  it("preserves safe built-in option ids without a duplicate backend registry", () => {
    const recipe = normalizePromptBuilderRecipe({
      version: 1,
      scope: "balanced",
      modifiers: ["future-option", "minimal", "future-option", "not a safe id"],
    });

    expect(recipe?.modifiers).toEqual(["future-option", "minimal"]);
  });

  it("includes the option library in the bootstrap settings response", async () => {
    const response = await createApp().request("/api/bootstrap");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { builderOptions?: unknown };
    expect(Array.isArray(body.builderOptions)).toBe(true);
  });
});

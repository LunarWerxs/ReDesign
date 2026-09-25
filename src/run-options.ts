/** Shared CLI/MCP parsing for paid run recipes. Invalid explicit values must fail closed. */
export function parseModelQuantities(value: unknown): Record<string, number> | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("model quantities must be a comma-separated list of modelId=positive-integer");
  const quantities: Record<string, number> = {};
  for (const rawPair of value.split(",")) {
    const pair = rawPair.trim();
    const equal = pair.indexOf("=");
    if (!pair || equal <= 0 || equal !== pair.lastIndexOf("=")) {
      throw new Error("model quantities must be a comma-separated list of modelId=positive-integer");
    }
    const id = pair.slice(0, equal).trim();
    const rawCount = pair.slice(equal + 1).trim();
    const count = Number(rawCount);
    if (!id || !/^\d+$/.test(rawCount) || !Number.isSafeInteger(count) || count < 1 || Object.hasOwn(quantities, id)) {
      throw new Error("model quantities must contain each model once with a positive integer count");
    }
    quantities[id] = count;
  }
  return quantities;
}

export function parseMaxCostUsd(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" && !value.trim()) throw new Error("max cost must be a finite nonnegative number");
  if (typeof value !== "string" && typeof value !== "number") throw new Error("max cost must be a finite nonnegative number");
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("max cost must be a finite nonnegative number");
  return amount;
}

/** Assemble the existing MCP wire contract once for run and batch_reimagine. */
export function buildMcpRunBody(input: Record<string, unknown>, inputName: "input" | "inputs" = "inputs"): Record<string, unknown> {
  const custom = typeof input.custom === "string" ? input.custom : null;
  const reference = input.reference
    ? { images: input.reference, note: typeof input.reference_note === "string" ? input.reference_note : null }
    : null;
  return {
    inputs: input[inputName] || "all",
    models: input.models || "all",
    prompts: { presets: input.prompts || (custom ? [] : "all"), custom },
    reference,
    variants: input.variants || 1,
    modelQuantities: parseModelQuantities(input.model_quantities),
    brandStyleGuide: typeof input.brand_style_guide === "string" ? input.brand_style_guide : null,
    mock: input.mock === true,
    // Only when asked for, so a plain recipe's wire body is unchanged.
    ...(input.self_check === true ? { selfCheck: true } : {}),
    concurrency: input.concurrency,
    maxImages: input.max_images,
    label: input.label,
    maxCostUsd: parseMaxCostUsd(input.max_cost),
  };
}

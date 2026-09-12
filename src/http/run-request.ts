import { loadModels, loadPrompts } from "../config";
import { listInputs } from "../inputResolver";
import { normalizeSelectionIds, type SelectionInput } from "../util";
import type { RunBody } from "./runQueue";

function badRequest(message: string): never {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  throw error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function explicitIds(value: unknown, label: string): string[] {
  if (value == null) badRequest(`${label} selection is required when provided`);
  if (typeof value !== "string" && !Array.isArray(value) && !isObject(value)) badRequest(`invalid ${label} selection`);
  const ids = normalizeSelectionIds(value as SelectionInput);
  if (!ids.length) badRequest(`${label} selection is empty`);
  if (ids.some((id) => typeof id !== "string" || !id)) badRequest(`invalid ${label} selection`);
  return ids;
}

function explicitPromptPresetIds(value: unknown, custom: unknown): string[] {
  if (value == null) badRequest("prompt preset selection is required when provided");
  if (typeof value !== "string" && !Array.isArray(value)) badRequest("invalid prompt preset selection");
  const ids = normalizeSelectionIds(value as SelectionInput);
  if (!ids.length && typeof custom === "string" && custom.trim()) return ids;
  if (!ids.length) badRequest("prompt preset selection is empty");
  return ids;
}

function validateExplicitSelection(value: unknown, label: string, validIds: Set<string>): void {
  const ids = explicitIds(value, label);
  if (ids.length === 1 && ids[0] === "all") return;
  const unknown = ids.find((id) => !validIds.has(id));
  if (unknown) badRequest(`unknown ${label}: ${unknown}`);
}

/**
 * Reject malformed or explicitly impossible paid work before it reaches the queue.
 * Omitted fields deliberately retain the CLI/MCP defaults; provided selections must
 * resolve against the current catalog instead of silently widening to those defaults.
 */
function validateRunRequest(value: unknown): RunBody {
  if (!isObject(value)) badRequest("request body must be a JSON object");
  const body = value as RunBody;

  for (const key of ["mock", "autoStart"] as const) {
    if (Object.hasOwn(body, key) && typeof body[key] !== "boolean") badRequest(`${key} must be a boolean`);
  }
  if (Object.hasOwn(body, "preflightId")) {
    if (typeof body.preflightId !== "string" || !body.preflightId.trim()) badRequest("invalid preflight token");
    if (Object.keys(body).some((key) => key !== "preflightId" && key !== "autoStart")) badRequest("A prepared run cannot be changed; prepare a new recipe instead.");
    return body;
  }
  if (Object.hasOwn(body, "maxCostUsd") && (typeof body.maxCostUsd !== "number" || !Number.isFinite(body.maxCostUsd) || body.maxCostUsd < 0)) badRequest("maxCostUsd must be a finite nonnegative number");
  if (body.reference != null && !isObject(body.reference)) badRequest("reference must be an object");
  if (body.modelQuantities != null && !isObject(body.modelQuantities)) badRequest("modelQuantities must be an object");
  for (const key of ["label", "brandStyleGuide"] as const) {
    if (body[key] != null && typeof body[key] !== "string") badRequest(`${key} must be a string`);
  }

  if (Object.hasOwn(body, "inputs")) {
    const inputs = listInputs();
    validateExplicitSelection(body.inputs, "input", new Set(inputs.flatMap((input) => [input.id, input.name])));
  }
  if (Object.hasOwn(body, "models")) {
    validateExplicitSelection(body.models, "model", new Set(loadModels().filter((model) => model.enabled !== false).map((model) => model.id)));
  }
  if (Object.hasOwn(body, "prompts")) {
    if (!isObject(body.prompts)) badRequest("prompts must be an object");
    const prompts = body.prompts;
    if (Object.hasOwn(prompts, "presets")) {
      const ids = explicitPromptPresetIds(prompts.presets, prompts.custom);
      const validIds = new Set(loadPrompts().prompts.map((prompt) => prompt.id));
      // The prompt resolver expands only the literal string sentinel. An array/CSV item
      // named "all" is an explicit preset ID, and must pass the same existence check.
      if (prompts.presets !== "all" && prompts.presets !== "*") {
        const unknown = ids.find((id) => !validIds.has(id));
        if (unknown) badRequest(`unknown prompt preset: ${unknown}`);
      }
    }
    if (Object.hasOwn(prompts, "custom") && prompts.custom != null && typeof prompts.custom !== "string") {
      badRequest("custom prompt must be a string");
    }
  }
  return body;
}

export { validateRunRequest };

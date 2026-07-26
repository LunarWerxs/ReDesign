import fs from "node:fs";
import { uniqueSlugId, writeJSON } from "../util";
import { jsonCache, PROMPTS_DEFAULTS_FILE, PROMPTS_FILE, readConfig } from "./shared";

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

interface PromptPreset {
  id: string;
  label: string;
  description?: string;
  user: string;
  starred?: boolean;
  pickerHidden?: boolean;
  builder?: PromptBuilderRecipe;
  source?: "preset" | "custom";
}

interface PromptBuilderRecipe {
  version: 1;
  scope: string;
  modifiers: string[];
  customOptions?: PromptBuilderOption[];
}

type PromptBuilderOptionCategory = "structure" | "design";

interface PromptBuilderOption {
  id: string;
  label: string;
  description?: string;
  instruction: string;
  category: PromptBuilderOptionCategory;
}

interface PromptsFileData {
  systemContract: string;
  prompts: PromptPreset[];
  builderOptions?: PromptBuilderOption[];
}

interface PromptsDefaultsData {
  prompts: PromptPreset[];
}

function loadPrompts(): PromptsFileData {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [], builderOptions: [] });
  return {
    systemContract: data.systemContract || "",
    prompts: Array.isArray(data.prompts) ? data.prompts : [],
    builderOptions: normalizeStoredPromptBuilderOptions(data.builderOptions),
  };
}

function writePromptsData(data: PromptsFileData): void {
  writeJSON(PROMPTS_FILE, data);
  const st = fs.statSync(PROMPTS_FILE);
  jsonCache.set(PROMPTS_FILE, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    data,
  });
}

interface PromptInput {
  id?: string;
  label?: string;
  user?: string;
  description?: string;
  starred?: boolean;
  builder?: unknown;
}

interface PromptBuilderOptionInput {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  instruction?: unknown;
  category?: unknown;
}

const PROMPT_BUILDER_SCOPES = new Set(["faithful", "balanced", "reimagine"]);
const PROMPT_BUILDER_OPTION_CATEGORIES = new Set<PromptBuilderOptionCategory>(["structure", "design"]);

const PROMPT_BUILDER_OPTION_LIMITS = {
  label: 100,
  description: 300,
  instruction: 4_000,
} as const;
const PROMPT_BUILDER_OPTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

function normalizedBuilderOptionText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength) return undefined;
  return text;
}

function parsePromptBuilderOption(value: unknown): PromptBuilderOption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as PromptBuilderOptionInput;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const label = normalizedBuilderOptionText(raw.label, PROMPT_BUILDER_OPTION_LIMITS.label);
  const description = normalizedBuilderOptionText(
    raw.description,
    PROMPT_BUILDER_OPTION_LIMITS.description,
  );
  const instruction = normalizedBuilderOptionText(
    raw.instruction,
    PROMPT_BUILDER_OPTION_LIMITS.instruction,
  );
  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  if (
    !id ||
    !PROMPT_BUILDER_OPTION_ID_PATTERN.test(id) ||
    !label ||
    !instruction ||
    !PROMPT_BUILDER_OPTION_CATEGORIES.has(category as PromptBuilderOptionCategory)
  ) {
    return undefined;
  }
  return {
    id,
    label,
    ...(description ? { description } : {}),
    instruction,
    category: category as PromptBuilderOptionCategory,
  };
}

function normalizeStoredPromptBuilderOptions(value: unknown): PromptBuilderOption[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const options: PromptBuilderOption[] = [];
  for (const item of value) {
    const option = parsePromptBuilderOption(item);
    if (!option || seenIds.has(option.id)) continue;
    seenIds.add(option.id);
    options.push(option);
  }
  return options;
}

function validatedPromptBuilderOptionFields(input: PromptBuilderOptionInput): Omit<PromptBuilderOption, "id"> {
  const label = normalizedBuilderOptionText(input.label, PROMPT_BUILDER_OPTION_LIMITS.label);
  if (!label) {
    const raw = typeof input.label === "string" ? input.label.trim() : "";
    throw statusError(
      raw.length > PROMPT_BUILDER_OPTION_LIMITS.label
        ? `label must be ${PROMPT_BUILDER_OPTION_LIMITS.label} characters or fewer`
        : "label is required",
      400,
    );
  }

  const instruction = normalizedBuilderOptionText(
    input.instruction,
    PROMPT_BUILDER_OPTION_LIMITS.instruction,
  );
  if (!instruction) {
    const raw = typeof input.instruction === "string" ? input.instruction.trim() : "";
    throw statusError(
      raw.length > PROMPT_BUILDER_OPTION_LIMITS.instruction
        ? `instruction must be ${PROMPT_BUILDER_OPTION_LIMITS.instruction} characters or fewer`
        : "instruction is required",
      400,
    );
  }

  const category = typeof input.category === "string" ? input.category.trim() : "";
  if (!PROMPT_BUILDER_OPTION_CATEGORIES.has(category as PromptBuilderOptionCategory)) {
    throw statusError("category must be structure or design", 400);
  }

  let description: string | undefined;
  if (input.description != null && String(input.description).trim()) {
    description = normalizedBuilderOptionText(
      input.description,
      PROMPT_BUILDER_OPTION_LIMITS.description,
    );
    if (!description) {
      throw statusError(
        `description must be ${PROMPT_BUILDER_OPTION_LIMITS.description} characters or fewer`,
        400,
      );
    }
  }

  return {
    label,
    ...(description ? { description } : {}),
    instruction,
    category: category as PromptBuilderOptionCategory,
  };
}

function normalizePromptBuilderRecipe(value: unknown): PromptBuilderRecipe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as {
    version?: unknown;
    scope?: unknown;
    modifiers?: unknown;
    customOptions?: unknown;
  };
  const scope = String(raw.scope || "").trim();
  if (raw.version !== 1 || !PROMPT_BUILDER_SCOPES.has(scope) || !Array.isArray(raw.modifiers)) return undefined;
  // Built-in option definitions live in the frontend registry. The backend only
  // validates their opaque IDs, so adding one does not require a second allowlist.
  const seenModifiers = new Set<string>();
  const modifiers = raw.modifiers
    .slice(0, 50)
    .map((id) => String(id || "").trim())
    .filter((id) => {
      if (!PROMPT_BUILDER_OPTION_ID_PATTERN.test(id) || seenModifiers.has(id)) return false;
      seenModifiers.add(id);
      return true;
    });
  const customOptions = normalizeStoredPromptBuilderOptions(raw.customOptions);
  return {
    version: 1,
    scope,
    modifiers,
    ...(customOptions.length ? { customOptions } : {}),
  };
}

function savePromptPreset(input: PromptInput = {}): PromptPreset {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  const prompts = Array.isArray(data.prompts) ? [...data.prompts] : [];
  const existingId = String(input.id || "").trim();
  const existingIndex = existingId ? prompts.findIndex((p) => p.id === existingId) : -1;
  const label = String(input.label || "").trim();
  const user = String(input.user || "").trim();
  const description = String(input.description || "").trim();
  const builder = normalizePromptBuilderRecipe(input.builder);

  if (!label) throw statusError("label is required", 400);
  if (!user) throw statusError("prompt text is required", 400);

  const id = existingIndex >= 0 ? existingId : uniqueSlugId(prompts, label, existingId, "prompt");
  // Preserve an existing prompt's star on edit; honor an explicit `starred` when sent.
  const prevStarred = existingIndex >= 0 ? prompts[existingIndex]?.starred === true : false;
  const nextPrompt: PromptPreset = {
    id,
    label,
    description,
    user,
    starred: input.starred == null ? prevStarred : !!input.starred,
    ...(builder ? { builder } : {}),
  };
  if (existingIndex >= 0) prompts[existingIndex] = nextPrompt;
  else prompts.push(nextPrompt);

  const nextData = { ...data, prompts };
  writePromptsData(nextData);
  return nextPrompt;
}

interface PromptBuilderOptionMutation {
  builderOption: PromptBuilderOption;
  builderOptions: PromptBuilderOption[];
}

function upsertPromptBuilderOption(
  current: unknown,
  input: PromptBuilderOptionInput = {},
): PromptBuilderOptionMutation {
  const builderOptions = normalizeStoredPromptBuilderOptions(current);
  const existingId = typeof input.id === "string" ? input.id.trim() : "";
  const existingIndex = existingId
    ? builderOptions.findIndex((option) => option.id === existingId)
    : -1;
  if (existingId && existingIndex < 0) throw statusError("prompt builder option not found", 404);

  const fields = validatedPromptBuilderOptionFields(input);
  const id =
    existingIndex >= 0
      ? existingId
      : uniqueSlugId(
          builderOptions,
          `custom ${fields.label}`,
          undefined,
          "builder-option",
        );
  const builderOption: PromptBuilderOption = { id, ...fields };
  if (existingIndex >= 0) builderOptions[existingIndex] = builderOption;
  else builderOptions.push(builderOption);
  return { builderOption, builderOptions };
}

function removePromptBuilderOption(
  current: unknown,
  id: unknown,
): { id: string; builderOptions: PromptBuilderOption[] } {
  const builderOptions = normalizeStoredPromptBuilderOptions(current);
  const optionId = typeof id === "string" ? id.trim() : "";
  if (!optionId) throw statusError("id is required", 400);
  const nextOptions = builderOptions.filter((option) => option.id !== optionId);
  if (nextOptions.length === builderOptions.length) {
    throw statusError("prompt builder option not found", 404);
  }
  return { id: optionId, builderOptions: nextOptions };
}

function savePromptBuilderOption(input: PromptBuilderOptionInput = {}): PromptBuilderOption {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, {
    systemContract: "",
    prompts: [],
    builderOptions: [],
  });
  const result = upsertPromptBuilderOption(data.builderOptions, input);
  writePromptsData({ ...data, builderOptions: result.builderOptions });
  return result.builderOption;
}

function deletePromptBuilderOption(id: unknown): string {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, {
    systemContract: "",
    prompts: [],
    builderOptions: [],
  });
  const result = removePromptBuilderOption(data.builderOptions, id);
  // Prompt bookmark recipes deliberately remain untouched: each recipe stores
  // a snapshot of its selected custom options and its compiled `user` text.
  writePromptsData({ ...data, builderOptions: result.builderOptions });
  return result.id;
}

// Toggle the picker "starred" hint on a prompt preset. Kept separate from
// savePromptPreset so a star toggle needn't re-send the whole prompt (and can't
// trip its label/text validation). Mirrors setModelStarred in config/models.ts.
function setPromptStarred(id: string, starred: boolean): PromptPreset {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  const prompts = Array.isArray(data.prompts) ? [...data.prompts] : [];
  const promptId = String(id || "").trim();
  if (!promptId) throw statusError("id is required", 400);
  const idx = prompts.findIndex((p) => p.id === promptId);
  if (idx < 0) throw statusError("prompt not found", 404);
  const next: PromptPreset = { ...(prompts[idx] as PromptPreset), starred: !!starred };
  prompts[idx] = next;
  writePromptsData({ ...data, prompts });
  return next;
}

function deletePromptPreset(id: string): string {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  const promptId = String(id || "").trim();
  if (!promptId) throw statusError("id is required", 400);
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const nextPrompts = prompts.filter((p) => p.id !== promptId);
  if (nextPrompts.length === prompts.length) throw statusError("prompt not found", 404);
  writePromptsData({ ...data, prompts: nextPrompts });
  return promptId;
}

function restoreDefaultPrompts(): PromptPreset[] {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  const defaults = readConfig<PromptsDefaultsData>(PROMPTS_DEFAULTS_FILE, { prompts: [] });
  const prompts = Array.isArray(defaults.prompts) ? defaults.prompts : [];
  if (!prompts.length) throw statusError("default prompts are missing", 500);
  const nextData = { ...data, prompts };
  writePromptsData(nextData);
  return prompts;
}

interface ResolvedPrompt extends PromptPreset {
  source: "preset" | "custom";
}

interface ResolvePromptsOptions {
  presets?: unknown;
  custom?: string;
}

/**
 * Build the list of prompt specs to run. Accepts selected preset ids and an
 * optional custom prompt. Falls back to the first default preset if nothing
 * is chosen, so a bare "run" still does something sensible.
 */
function resolvePrompts({ presets, custom }: ResolvePromptsOptions = {}): ResolvedPrompt[] {
  const { prompts } = loadPrompts();
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const out: ResolvedPrompt[] = [];

  let ids: unknown = presets;
  if (ids === "all" || ids === "*") ids = prompts.map((p) => p.id);
  if (typeof ids === "string") ids = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const found = byId.get(id);
      if (found) out.push({ ...found, source: "preset" });
    }
  }

  const customText = (custom || "").trim();
  if (customText) out.push({ id: "custom", label: "Custom", user: customText, source: "custom" });

  if (!out.length) {
    const fallback = prompts[0];
    if (fallback) out.push({ ...fallback, source: "preset" });
  }
  return out;
}

export type {
  PromptBuilderOption,
  PromptBuilderOptionCategory,
  PromptBuilderOptionInput,
  PromptBuilderRecipe,
  PromptInput,
  PromptPreset,
  PromptsFileData,
  ResolvedPrompt,
};
export {
  deletePromptBuilderOption,
  deletePromptPreset,
  loadPrompts,
  normalizePromptBuilderRecipe,
  normalizeStoredPromptBuilderOptions,
  removePromptBuilderOption,
  resolvePrompts,
  restoreDefaultPrompts,
  savePromptBuilderOption,
  savePromptPreset,
  setPromptStarred,
  upsertPromptBuilderOption,
};

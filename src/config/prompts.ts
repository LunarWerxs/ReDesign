import fs from "node:fs";
import { writeJSON, uniqueSlugId } from "../util";
import { PROMPTS_FILE, PROMPTS_DEFAULTS_FILE, jsonCache, readConfig } from "./shared";

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
  source?: "preset" | "custom";
}

interface PromptsFileData {
  systemContract: string;
  prompts: PromptPreset[];
}

interface PromptsDefaultsData {
  prompts: PromptPreset[];
}

function loadPrompts(): PromptsFileData {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  return { systemContract: data.systemContract || "", prompts: data.prompts || [] };
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
}

function savePromptPreset(input: PromptInput = {}): PromptPreset {
  const data = readConfig<PromptsFileData>(PROMPTS_FILE, { systemContract: "", prompts: [] });
  const prompts = Array.isArray(data.prompts) ? [...data.prompts] : [];
  const existingId = String(input.id || "").trim();
  const existingIndex = existingId ? prompts.findIndex((p) => p.id === existingId) : -1;
  const label = String(input.label || "").trim();
  const user = String(input.user || "").trim();
  const description = String(input.description || "").trim();

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
  };
  if (existingIndex >= 0) prompts[existingIndex] = nextPrompt;
  else prompts.push(nextPrompt);

  const nextData = { ...data, prompts };
  writePromptsData(nextData);
  return nextPrompt;
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

export {
  loadPrompts,
  resolvePrompts,
  savePromptPreset,
  setPromptStarred,
  deletePromptPreset,
  restoreDefaultPrompts,
};
export type { PromptPreset, PromptInput, PromptsFileData, ResolvedPrompt };

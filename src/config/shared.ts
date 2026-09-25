import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { APP_CONFIG_DIR, readJSON, writeJSON } from "../util";
import { mergeShippedRecords } from "./migration";
import legacyShipped from "./legacy-shipped.json";
import modelsSeed from "./models.json";
import pricingSeed from "./pricing.json";
import promptDefaultsSeed from "./prompts.defaults.json";
import promptsSeed from "./prompts.json";

// ONE live config location, packaged or from source: <REDESIGN_HOME|~/.redesign>/config.
//
// Running from source used to point this at src/config/ itself, which meant the app wrote
// user data (saved prompts, Prompt Builder combos, models added in the UI) straight into
// tracked files that are ALSO compiled into the shipped binary as seeds. Every dev-mode
// session dirtied the repo, and a stray commit would have published someone's private
// presets. Now the .json files beside this one are seeds only: read at build time, copied
// out on first run, never written back.
const CONFIG_ROOT = path.join(APP_CONFIG_DIR, "config");
const MODELS_FILE = path.join(CONFIG_ROOT, "models.json");
const PROMPTS_FILE = path.join(CONFIG_ROOT, "prompts.json");
const PROMPTS_DEFAULTS_FILE = path.join(CONFIG_ROOT, "prompts.defaults.json");
const PRICING_FILE = path.join(CONFIG_ROOT, "pricing.json");
const SHIPPED_BASELINE_FILE = path.join(CONFIG_ROOT, ".reimagine-shipped-baseline.json");
// User data only (no seed): the owner's pairwise "which is better" votes, see src/arena.ts.
const ARENA_VOTES_FILE = path.join(CONFIG_ROOT, "arena-votes.json");

fs.mkdirSync(CONFIG_ROOT, { recursive: true });

type ShippedRecord = { id?: unknown; [key: string]: unknown };
type ShippedBaseline = {
  version: 1;
  revision: string;
  models: ShippedRecord[];
  prompts: ShippedRecord[];
  systemContract?: string;
};

const CONFIG_LOCK_FILE = path.join(CONFIG_ROOT, ".reimagine-config.lock");
let configLockDepth = 0;
/** Take the lock file, retrying until the deadline; throws 409 if another live process holds it. */
function acquireConfigLock(): { fd: number; token: string } {
  const token = randomUUID();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2_000;
  let fd: number | undefined;
  while (fd === undefined && Date.now() < deadline) {
    try {
      fd = fs.openSync(CONFIG_LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      reclaimStaleConfigLock();
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  if (fd === undefined) throw Object.assign(new Error("Configuration is busy in another process; retry the change."), { status: 409 });
  return { fd, token };
}

/** Drop a lock only when its recorded owner is no longer alive; a live owner keeps it. */
function reclaimStaleConfigLock(): void {
  try {
    const owner = JSON.parse(fs.readFileSync(CONFIG_LOCK_FILE, "utf8")) as { pid?: number };
    if (!Number.isInteger(owner.pid) || (owner.pid || 0) <= 0) return;
    try { process.kill(owner.pid as number, 0); } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(CONFIG_LOCK_FILE, { force: true });
    }
  } catch { /* lock owner may have released it */ }
}

/** Close the descriptor and remove the lock file, but only if this holder still owns it. */
function releaseConfigLock(fd: number, token: string): void {
  try {
    fs.closeSync(fd);
    const owner = JSON.parse(fs.readFileSync(CONFIG_LOCK_FILE, "utf8")) as { token?: string };
    if (owner.token === token) fs.rmSync(CONFIG_LOCK_FILE, { force: true });
  } catch { /* best effort */ }
}

function withConfigLock<T>(work: () => T): T {
  if (configLockDepth) {
    configLockDepth += 1;
    try { return work(); } finally { configLockDepth -= 1; }
  }
  const { fd, token } = acquireConfigLock();
  configLockDepth = 1;
  try { return work(); }
  finally {
    configLockDepth = 0;
    releaseConfigLock(fd, token);
  }
}
function jsonText(data: unknown): string { return `${JSON.stringify(data, null, 2)}\n`; }
function writeConfigJSONIfChanged(file: string, data: unknown): boolean {
  const next = jsonText(data);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) return false;
  writeJSON(file, data);
  return true;
}

function records(value: unknown): ShippedRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ShippedRecord => !!item && typeof item === "object") : [];
}

/** Refresh shipped definitions while preserving edits and explicit model archives. */
function migrateShippedConfig(): void {
  try { withConfigLock(() => migrateShippedConfigLocked()); } catch (error) {
    // A reader may use the last valid files while a different process is migrating.
    // Mutations call withConfigLock directly and return an explicit conflict on timeout.
    if (!fs.existsSync(MODELS_FILE) || !fs.existsSync(PROMPTS_FILE)) throw error;
  }
}
/** Baseline-tracked profile: apply shipped corrections to untouched records, keep edits and archives. */
function applyBaselineMigration(modelsData: Record<string, unknown>, promptsData: Record<string, unknown>, baseline: ShippedBaseline, seedModels: ShippedRecord[], seedPrompts: ShippedRecord[], systemContract: unknown): void {
  const archive = records(modelsData.modelArchive);
  modelsData.models = mergeShippedRecords(records(modelsData.models), baseline.models, seedModels, archive.map((m) => String(m.id || "")));
  const currentPrompts = records(promptsData.prompts);
  promptsData.prompts = mergeShippedRecords(currentPrompts, baseline.prompts, seedPrompts, baseline.prompts.filter((old) => !currentPrompts.some((p) => p.id === old.id)).map((p) => String(p.id || "")));
  if (baseline.systemContract !== undefined && promptsData.systemContract === baseline.systemContract) {
    promptsData.systemContract = systemContract;
  }
}

/**
 * Profiles created by the immediately preceding 1.6.6 build have no baseline file. Its tracked
 * catalog is embedded here so exact old shipped records receive corrections while edits, explicit
 * prompt deletions and archived models remain untouched.
 */
function applyLegacyMigration(modelsData: Record<string, unknown>, promptsData: Record<string, unknown>, seedModels: ShippedRecord[], seedPrompts: ShippedRecord[], systemContract: unknown): void {
  const legacyModels = records((legacyShipped.models as { models?: unknown }).models);
  const legacyPrompts = records((legacyShipped.prompts as { prompts?: unknown }).prompts);
  const archive = records(modelsData.modelArchive);
  modelsData.models = mergeShippedRecords(records(modelsData.models), legacyModels, seedModels, archive.map((m) => String(m.id || "")));
  const currentPrompts = records(promptsData.prompts);
  promptsData.prompts = mergeShippedRecords(currentPrompts, legacyPrompts, seedPrompts, legacyPrompts.filter((old) => !currentPrompts.some((p) => p.id === old.id)).map((p) => String(p.id || "")));
  if (promptsData.systemContract === legacyShipped.prompts.systemContract) promptsData.systemContract = systemContract;
}

function migrateShippedConfigLocked(): void {
  const hadModels = fs.existsSync(MODELS_FILE);
  const hadPrompts = fs.existsSync(PROMPTS_FILE);
  const baseline = readJSON<ShippedBaseline | null>(SHIPPED_BASELINE_FILE, null);
  const modelsData = readJSON<Record<string, unknown>>(MODELS_FILE, { models: modelsSeed.models });
  const promptsData = readJSON<Record<string, unknown>>(PROMPTS_FILE, promptsSeed as Record<string, unknown>);
  const seedModels = records((modelsSeed as { models?: unknown }).models);
  const seedPrompts = records((promptsSeed as { prompts?: unknown }).prompts);
  const systemContract = (promptsSeed as { systemContract?: unknown }).systemContract;
  const revision = createHash("sha256").update(JSON.stringify({ modelsSeed, promptsSeed, promptDefaultsSeed })).digest("hex");
  const nextBaseline: ShippedBaseline = { version: 1, revision, models: seedModels, prompts: seedPrompts, ...(typeof systemContract === "string" ? { systemContract } : {}) };
  if (hadModels && hadPrompts && fs.existsSync(PROMPTS_DEFAULTS_FILE) && baseline?.version === 1 && baseline.revision === nextBaseline.revision) return;

  if (baseline?.version === 1) {
    applyBaselineMigration(modelsData, promptsData, baseline, seedModels, seedPrompts, systemContract);
  } else if (hadModels || hadPrompts) {
    applyLegacyMigration(modelsData, promptsData, seedModels, seedPrompts, systemContract);
  } else {
    // A fresh profile gets exact shipped content. Existing pre-baseline profiles are deliberately
    // left alone on this first bootstrap: guessing whether an absent item was deleted loses data.
    modelsData.models = seedModels;
    Object.assign(promptsData, promptsSeed);
  }
  try {
    writeConfigJSONIfChanged(MODELS_FILE, modelsData);
    writeConfigJSONIfChanged(PROMPTS_FILE, promptsData);
    // Defaults are immutable restore source, not a user-editable catalog: always refresh them.
    writeConfigJSONIfChanged(PROMPTS_DEFAULTS_FILE, promptDefaultsSeed);
    writeConfigJSONIfChanged(SHIPPED_BASELINE_FILE, nextBaseline);
  } catch (_) {
    /* read-only profiles keep their existing usable files */
  }
}

migrateShippedConfig();

// pricing.json is the one seed with no user-editable path: nothing in the UI, the CLI or the API
// writes it (scripts/update-pricing.ts refreshes the SEED in the repo, which then ships inside the
// binary). Copy-on-first-run therefore froze an install's cost estimates at whatever prices were
// current the day it was installed, forever, including across auto-updates. Re-seed it whenever the
// shipped seed differs from what is on disk; there is no user edit here to lose.
const pricingSeedText = `${JSON.stringify(pricingSeed, null, 2)}\n`;
try {
  const onDisk = fs.existsSync(PRICING_FILE) ? fs.readFileSync(PRICING_FILE, "utf8") : null;
  if (onDisk !== pricingSeedText) fs.writeFileSync(PRICING_FILE, pricingSeedText, "utf8");
} catch (_) {
  /* a read-only or locked config dir must not stop the app booting; stale prices are survivable */
}

interface JsonCacheEntry<T> {
  mtimeMs: number;
  size: number;
  data: T;
}

const jsonCache = new Map<string, JsonCacheEntry<unknown>>();
const MODEL_ARCHIVE_KEY = "modelArchive";

const MODEL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-compatible",
  "gemini",
  "google",
  "deepseek",
  "qwen",
  "xai",
  "openrouter",
  "groq",
  "mistral",
  "moonshot",
  "metaai",
]);

// Every provider that speaks the OpenAI chat-completions shape (Bearer auth,
// GET /models listing, max_tokens vs max_completion_tokens). Used to pick the
// OpenAI adapter (providers.ts), gate the tokenParam field (config/models.ts),
// and drive which services an ambiguous `sk-` key is probed against (keyDetect.ts).
const OPENAI_FAMILY = new Set([
  "openai",
  "openai-compatible",
  "deepseek",
  "qwen",
  "xai",
  "openrouter",
  "groq",
  "mistral",
  "moonshot",
  "metaai",
]);

// Display names for grouping the picker by service and labelling key-import
// results. The catalog's Model.label is per-model; this is per-provider.
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
  gemini: "Google Gemini",
  google: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  xai: "xAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  moonshot: "Moonshot",
  metaai: "Meta AI",
};

interface ProviderDefaults {
  baseUrl: string;
  keyEnv: string;
  color: string;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEYS",
    color: "#a06bff",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEYS",
    color: "#10a37f",
  },
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_COMPATIBLE_API_KEYS",
    color: "#4d6bfe",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEYS",
    color: "#4285f4",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEYS",
    color: "#4285f4",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEYS",
    color: "#4d6bfe",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "QWEN_API_KEYS",
    color: "#615ced",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEYS",
    color: "#1f6feb",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEYS",
    color: "#6467f2",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEYS",
    color: "#f55036",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEYS",
    color: "#ff7000",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: "MOONSHOT_API_KEYS",
    color: "#16b8a6",
  },
  metaai: {
    baseUrl: "https://api.meta.ai/v1",
    keyEnv: "METAAI_API_KEYS",
    color: "#0866ff",
  },
};

function readConfig<T>(file: string, fallback: T): T {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return fallback;
  }
  const cached = jsonCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data as T;
  const data = readJSON(file, fallback);
  jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function providerDefault(provider: string, key: keyof ProviderDefaults): string {
  return PROVIDER_DEFAULTS[provider]?.[key] || "";
}

export type { JsonCacheEntry, ProviderDefaults };
export {
  ARENA_VOTES_FILE,
  jsonCache,
  MODEL_ARCHIVE_KEY,
  MODEL_PROVIDERS,
  MODELS_FILE,
  OPENAI_FAMILY,
  PRICING_FILE,
  PROMPTS_DEFAULTS_FILE,
  PROMPTS_FILE,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  providerDefault,
  withConfigLock,
  writeConfigJSONIfChanged,
  readConfig,
};

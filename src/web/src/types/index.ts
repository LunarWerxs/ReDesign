// Shapes mirror the Node backend (server.js / runner.js / store.js / keyManager.js).
// Kept intentionally permissive where the backend is loose.

export interface Model {
  id: string;
  label: string;
  provider?: string;
  apiModel?: string;
  keyEnv?: string;
  baseUrl?: string;
  vision: boolean;
  enabled: boolean;
  color?: string;
  keys: number;
  maxTokens?: number;
  temperature?: number | null;
  tokenParam?: string;
  supportsTemperature?: boolean;
}

export interface AvailableModel {
  id: string;
  label: string;
  source: 'provider' | 'catalog';
}

export interface AvailableModelsResponse {
  models: AvailableModel[];
  source: 'provider' | 'catalog';
}

export interface Prompt {
  id: string;
  label: string;
  description?: string;
  user?: string;
}

export type InputType = 'image' | 'group';

export interface InputItem {
  id: string;
  name: string;
  type: InputType;
  preview: string;
  imageCount?: number;
  images?: string[];
}

export interface ReferenceItem {
  id: string;
  name: string;
  preview: string;
}

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'ok'
  | 'error'
  | 'skipped'
  | 'cancelled';

export interface JobCost {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  estimate: boolean;
  priced: boolean;
}

export interface Job {
  id: string;
  inputId: string;
  modelId: string;
  promptId: string;
  variant: number;
  status: JobStatus;
  file?: string | null;
  error?: string | null;
  ms?: number;
  wrapped?: boolean;
  truncated?: boolean;
  usage?: unknown;
  cost?: JobCost | null;
}

export interface Counts {
  total: number;
  done?: number;
  ok?: number;
  error?: number;
  skipped?: number;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface RunCost {
  totalCost: number;
  currency: string;
  jobCount: number;
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
}

export interface RunSummaryMeta {
  title?: string;
  source?: string;
}

export interface Manifest {
  runId: string;
  status: RunStatus;
  mock?: boolean;
  summary?: RunSummaryMeta | null;
  counts?: Counts;
  cost?: RunCost;
  queue?: { position?: number } | null;
  inputs: InputItem[];
  prompts: Prompt[];
  models: Model[];
  jobs: Job[];
  error?: string;
}

export interface RunSummary {
  runId: string;
  title?: string;
  summary?: RunSummaryMeta | null;
  status: RunStatus;
  counts?: Counts;
  cost?: RunCost;
  total?: number;
  mock?: boolean;
}

export interface RunDeleteSkipped {
  runId: string;
  reason: string;
}

export interface RunDeleteResponse {
  deleted: string[];
  skipped: RunDeleteSkipped[];
  runs: RunSummary[];
}

export type KeyStatus = 'ok' | 'dead' | 'no_balance' | 'cooldown' | 'untested';

export interface KeyEntry {
  id: string;
  mask: string;
  status: KeyStatus | string;
  successes: number;
  failures: number;
  cooldownRemainingSec?: number;
  lastError?: string | null;
}

export interface KeyPool {
  pool: string;
  total: number;
  available: number;
  dead: number;
  noBalance: number;
  cooling: number;
  entries: KeyEntry[];
}

export interface KeySnapshot {
  updatedAt?: string;
  pools: KeyPool[];
}

export interface SpendToDate {
  totalCost: number;
  currency: string;
  runCount: number;
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
  pricingLastUpdated: string | null;
}

export interface EstimateRunCost {
  totalCost: number;
  currency: string;
  anyEstimatePricing: boolean;
  anyUnpriced: boolean;
  anyFromDefault: boolean;
  byModel: Record<string, { jobs: number; totalCost: number; fromHistory: boolean }>;
}

export interface ProviderDefault {
  baseUrl: string;
  keyEnv: string;
  color: string;
}

export interface BootstrapResponse {
  models: Model[];
  archivedModels?: Model[];
  prompts: Prompt[];
  inputs: InputItem[];
  references?: ReferenceItem[];
  keys: KeySnapshot;
  runs: RunSummary[];
  spend?: SpendToDate;
  providerDefaults: Record<string, ProviderDefault>;
}

export interface ModelSaveRequest {
  id?: string;
  label: string;
  provider: string;
  apiModel: string;
  keyEnv: string;
  baseUrl: string;
  vision: boolean;
  enabled: boolean;
  maxTokens: number;
  supportsTemperature: boolean;
  temperature?: number | null;
  tokenParam?: string;
  color?: string;
}

export interface ModelSettingsResponse {
  model?: Model;
  id?: string;
  models: Model[];
  archivedModels: Model[];
  keys: KeySnapshot;
}

export interface UploadImage {
  name: string;
  mime: string;
  data: string;
}

export interface UploadResponse {
  inputs: InputItem[];
  addedIds?: string[];
  saved?: unknown[];
}

export interface RunRequest {
  inputs: { ids: string[] };
  models: { ids: string[] };
  prompts: { presets: string[]; custom: string | null };
  variants: number;
  maxImages: number;
  mock: boolean;
  reference?: { images: string[]; note: string | null };
}

export interface HealthCheckResponse {
  results?: unknown[];
  keys: KeySnapshot;
}

export interface UpdateStatus {
  ok: boolean;
  service: 'redesign';
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

// "Sync my settings with Connections" (opt-in cloud sync of theme; GET/PUT /api/settings/sync).
export interface SyncStatusOk {
  ok: true;
  enabled: boolean;
  connected: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
  lastSyncedAt: string | null;
  version: number;
  appearance: Record<string, unknown> | null;
}

// A handled failure, HTTP 200, shown inline/non-blocking (never thrown by the api layer).
export interface SyncStatusError {
  ok: false;
  error: string;
  retryAfterSeconds?: number;
}

export type SyncStatus = SyncStatusOk | SyncStatusError;

export interface AuthMe {
  ok: true;
  connected: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
}

// Local daemon settings (GET/PUT /api/settings), currently just the auto-update opt-in +
// cadence (see src/auto-update.ts). Distinct from the Connections cloud-synced appearance blob
// above (SyncStatus / /api/settings/sync).
export interface AppSettings {
  ok: true;
  autoUpdate: boolean;
  autoUpdateIntervalSecs: number;
  portableMode: boolean;
}

// Server-Sent Events emitted by GET /api/runs/:id/events.
export type RunEvent =
  | { type: 'start'; runId: string; manifest: Manifest }
  | { type: 'snapshot'; runId: string; manifest: Manifest }
  | { type: 'job'; runId: string; job: Job }
  | { type: 'done'; runId: string; manifest: Manifest }
  | { type: 'error'; runId: string; message: string; manifest?: Manifest };

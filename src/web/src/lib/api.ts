import type {
  AppSettings,
  AuthMe,
  AvailableModelsResponse,
  BootstrapResponse,
  EstimateRunCost,
  HealthCheckResponse,
  KeySnapshot,
  Manifest,
  ModelSaveRequest,
  ModelSettingsResponse,
  Prompt,
  RunDeleteResponse,
  RunRequest,
  RunSummary,
  SpendToDate,
  SyncStatus,
  UploadImage,
  UploadResponse,
  UpdateApplyResult,
  UpdateStatus,
} from '@/types';
import { httpJson } from "@/lib/httpClient";
export { ApiError } from "@/lib/httpClient";

const request = httpJson;

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Encode each path segment so names with #, ?, &, +, spaces survive in URLs. */
export const encPath = (rel: string): string =>
  String(rel)
    .split('/')
    .map(encodeURIComponent)
    .join('/');

export const inputUrl = (rel: string) => `/input/${encPath(rel)}`;
export const referenceUrl = (rel: string) => `/reference/${encPath(rel)}`;
export const outputUrl = (rel: string) => `/output/${encPath(rel)}`;
export const outputRawUrl = (rel: string, opts?: { measure?: boolean }) =>
  `/output-raw/${encPath(rel)}${opts?.measure ? '?measure=1' : ''}`;
export const downloadUrl = (rel: string) => `/output/${encPath(rel)}?download=1`;
export const eventsUrl = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`;

export const api = {
  bootstrap: () => request<BootstrapResponse>('/api/bootstrap'),
  // ── "Sync my settings with Connections" (opt-in cloud sync of theme) ────────
  getSyncStatus: () => request<SyncStatus>('/api/settings/sync'),
  setSync: (body: { enabled?: boolean; forget?: boolean; appearance?: Record<string, unknown> }) =>
    request<SyncStatus>('/api/settings/sync', { ...postJson(body), method: 'PUT' }),
  syncPull: () => request<SyncStatus>('/api/settings/sync/pull', { method: 'POST' }),
  syncPush: () => request<SyncStatus>('/api/settings/sync/push', { method: 'POST' }),
  authMe: () => request<AuthMe>('/api/auth/me'),
  authLogout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  checkUpdate: () => request<UpdateStatus>('/api/updates'),
  applyUpdate: () => request<UpdateApplyResult>('/api/updates/apply', { method: 'POST' }),
  // ── local daemon settings (auto-update opt-in + cadence, portable window opt-in) ─────────────
  getSettings: () => request<AppSettings>('/api/settings'),
  setAutoUpdate: (enabled: boolean) =>
    request<AppSettings>('/api/settings', { ...postJson({ autoUpdate: enabled }), method: 'PUT' }),
  setPortableMode: (enabled: boolean) =>
    request<AppSettings>('/api/settings', { ...postJson({ portableMode: enabled }), method: 'PUT' }),
  setHideTrayIcon: (enabled: boolean) =>
    request<AppSettings>('/api/settings', { ...postJson({ hideTrayIcon: enabled }), method: 'PUT' }),
  openPortableWindow: () =>
    request<{ ok: true; browser: string } | { ok: false; reason: 'no-browser' | 'spawn-failed' }>(
      '/api/portable-window',
      postJson({}),
    ),
  recordPulse: (event: string, properties?: Record<string, unknown>) =>
    request<{ ok: boolean; enabled: boolean }>('/api/pulse', postJson({ event, properties })),
  uploadInputs: (images: UploadImage[]) =>
    request<UploadResponse>('/api/inputs/upload', postJson({ images })),
  deleteInput: (id: string) =>
    request<{ inputs: import('@/types').InputItem[] }>('/api/inputs/delete', postJson({ id })),
  keys: () => request<KeySnapshot>('/api/keys'),
  saveKey: (body: { pool: string; id?: string; key: string }) =>
    request<{ keys: KeySnapshot }>('/api/keys/save', postJson(body)),
  deleteKey: (body: { pool: string; id: string }) =>
    request<{ keys: KeySnapshot }>('/api/keys/delete', postJson(body)),
  availableModels: (params: { provider: string; baseUrl?: string; keyEnv?: string }) => {
    const qs = new URLSearchParams({ provider: params.provider });
    if (params.baseUrl) qs.set('baseUrl', params.baseUrl);
    if (params.keyEnv) qs.set('keyEnv', params.keyEnv);
    return request<AvailableModelsResponse>(`/api/models/available?${qs.toString()}`);
  },
  saveModel: (body: ModelSaveRequest) =>
    request<ModelSettingsResponse>('/api/models/save', postJson(body)),
  deleteModel: (id: string) =>
    request<ModelSettingsResponse>('/api/models/delete', postJson({ id })),
  restoreModel: (id: string) =>
    request<ModelSettingsResponse>('/api/models/restore', postJson({ id })),
  reorderModels: (order: string[]) =>
    request<ModelSettingsResponse>('/api/models/reorder', postJson({ order })),
  runs: () => request<RunSummary[]>('/api/runs'),
  deleteRuns: (ids: string[]) =>
    request<RunDeleteResponse>('/api/runs/delete', postJson({ ids })),
  run: (id: string) => request<Manifest>(`/api/runs/${encodeURIComponent(id)}`),
  startRun: (body: RunRequest) => request<{ runId: string }>('/api/run', postJson(body)),
  cancelRun: (id: string) =>
    request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  healthCheck: (opts?: { signal?: AbortSignal }) =>
    request<HealthCheckResponse>('/api/health-check', { ...postJson({ models: 'all' }), signal: opts?.signal }),
  openOutput: (file: string, target: 'file' | 'folder') =>
    request<{ ok: boolean }>('/api/output/open', postJson({ file, target })),
  savePrompt: (prompt: { id?: string; label: string; description?: string; user: string }) =>
    request<{ prompt: Prompt; prompts: Prompt[] }>('/api/prompts/save', postJson(prompt)),
  deletePrompt: (id: string) =>
    request<{ id: string; prompts: Prompt[] }>('/api/prompts/delete', postJson({ id })),
  restoreDefaultPrompts: () =>
    request<{ prompts: Prompt[] }>('/api/prompts/restore-defaults', postJson({})),
  shutdownServer: () => request<{ ok: boolean }>('/api/shutdown', postJson({})),
  costs: () => request<SpendToDate>('/api/costs'),
  estimateRunCost: (body: { modelIds: string[]; jobCount: number }) =>
    request<EstimateRunCost>('/api/costs/estimate', postJson(body)),
};

import { toast } from 'vue-sonner';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import { withToast } from '@/lib/asyncAction';
import type { ImportKeysResponse, KeySnapshot, Model, ModelSaveRequest, ModelSettingsResponse } from '@/types';
import { errMessage, isRunnable } from './state';
import type { ControlState } from './state';

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export function createKeysModelsActions(state: ControlState) {
  // ---- live check (two-step confirm) ----
  let liveCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let liveCheckController: AbortController | null = null;

  function applyKeyCounts(snapshot: KeySnapshot | null) {
    const totals = new Map((snapshot?.pools || []).map((p) => [p.pool, p.total]));
    state.models.value = state.models.value.map((m) =>
      m.keyEnv && totals.has(m.keyEnv) ? { ...m, keys: totals.get(m.keyEnv) || 0 } : m,
    );
  }

  function applyModelSettings(result: ModelSettingsResponse) {
    state.models.value = result.models || [];
    state.archivedModels.value = result.archivedModels || [];
    state.keys.value = result.keys || state.keys.value;
    applyKeyCounts(state.keys.value);
    reconcileModelSelection(state.models.value);
  }

  function reconcileModelSelection(nextModels: Model[]) {
    const runnableIds = new Set(nextModels.filter(isRunnable).map((m) => m.id));
    state.selModels.value = state.selModels.value.filter((id) => runnableIds.has(id));
    // Prune per-model quantities for models that are no longer selectable.
    const kept = new Set(state.selModels.value);
    const nextQty: Record<string, number> = {};
    for (const [id, q] of Object.entries(state.modelQty.value)) if (kept.has(id)) nextQty[id] = q;
    state.modelQty.value = nextQty;
  }

  async function refreshKeys() {
    try {
      state.keys.value = await api.keys();
      applyKeyCounts(state.keys.value);
    } catch {
      /* non-fatal */
    }
  }

  function applyKeys(r: { keys: KeySnapshot }) {
    state.keys.value = r.keys;
    applyKeyCounts(state.keys.value);
  }

  function saveKey(body: { pool: string; id?: string; key: string }) {
    return withToast(() => api.saveKey(body), {
      onSuccess: applyKeys,
      successMsg: body.id ? t('keys.updated') : t('keys.added'),
      errKey: 'keys.saveFailed',
    });
  }

  function deleteKey(pool: string, id: string) {
    return withToast(() => api.deleteKey({ pool, id }), {
      onSuccess: applyKeys,
      successMsg: t('keys.deleted'),
      errKey: 'keys.deleteFailed',
    });
  }

  function saveModel(body: ModelSaveRequest) {
    return withToast(() => api.saveModel(body), {
      onSuccess: applyModelSettings,
      successMsg: body.id ? t('models.updated') : t('models.added'),
      errKey: 'models.saveFailed',
    });
  }

  // Toggle a model's picker "starred" flag. Silent (no success toast) so rapid
  // star/unstar from the picker doesn't spam.
  function toggleModelStarred(id: string) {
    const current = state.models.value.find((m) => m.id === id);
    const nextStarred = !current?.starred;
    return withToast(() => api.starModel(id, nextStarred), {
      onSuccess: applyModelSettings,
      errKey: 'models.starFailed',
    });
  }

  // Paste-and-autodetect: send a blob of keys, apply the returned key snapshot,
  // and hand the per-key results back to the caller so it can show what happened.
  async function importKeys(text: string): Promise<ImportKeysResponse> {
    const r = await api.importKeys(text);
    applyKeys({ keys: r.keys });
    return r;
  }

  function deleteModel(id: string) {
    return withToast(() => api.deleteModel(id), {
      onSuccess: applyModelSettings,
      successMsg: t('models.removed'),
      errKey: 'models.removeFailed',
    });
  }

  function reorderModels(order: string[]) {
    return withToast(() => api.reorderModels(order), {
      onSuccess: applyModelSettings,
      errKey: 'models.reorderFailed',
    });
  }

  function restoreModel(id: string) {
    return withToast(() => api.restoreModel(id), {
      onSuccess: applyModelSettings,
      successMsg: t('models.restored'),
      errKey: 'models.restoreFailed',
    });
  }

  function resetLiveCheck() {
    state.liveCheckArmed.value = false;
    if (liveCheckTimer) clearTimeout(liveCheckTimer);
    liveCheckTimer = null;
  }

  function cancelLiveCheck() {
    if (!state.liveCheckBusy.value) {
      resetLiveCheck();
      return;
    }
    liveCheckController?.abort();
  }

  async function liveCheck() {
    if (state.liveCheckBusy.value) {
      cancelLiveCheck();
      return;
    }
    if (!state.liveCheckArmed.value) {
      state.liveCheckArmed.value = true;
      toast(t('keys.checkArm'));
      if (liveCheckTimer) clearTimeout(liveCheckTimer);
      liveCheckTimer = setTimeout(resetLiveCheck, 6000);
      return;
    }
    resetLiveCheck();
    state.liveCheckBusy.value = true;
    const controller = new AbortController();
    liveCheckController = controller;
    try {
      toast(t('keys.checkStarted'));
      const r = await api.healthCheck({ signal: controller.signal });
      if (controller.signal.aborted) return;
      state.keys.value = r.keys;
      applyKeyCounts(state.keys.value);
      toast.success(t('keys.checkComplete'));
    } catch (e) {
      if (controller.signal.aborted || isAbortError(e)) toast(t('keys.checkCancelled'));
      else toast.error(t('keys.checkFailed'), { description: errMessage(e) });
    } finally {
      if (liveCheckController === controller) liveCheckController = null;
      state.liveCheckBusy.value = false;
    }
  }

  return {
    refreshKeys,
    saveKey,
    deleteKey,
    importKeys,
    saveModel,
    toggleModelStarred,
    deleteModel,
    reorderModels,
    restoreModel,
    liveCheck,
    cancelLiveCheck,
    resetLiveCheck,
  };
}

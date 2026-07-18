import { toast } from 'vue-sonner';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import type { UpdateStatus } from '@/types';
import { errMessage, isRunnable } from './state';
import type { ControlState } from './state';

let appOpenedPulsed = false;

/** Self-update now lives in the shared `useSelfUpdate` composable; bootstrap only
 *  needs its `checkForUpdate` to kick off a background check once data has loaded. */
interface AppLifecycleDeps {
  checkForUpdate: () => Promise<UpdateStatus | null>;
  /** Re-attach to runs the server is still working on (see ./runs.ts resumeRuns). */
  resumeRuns: () => Promise<void>;
}

export function createAppLifecycleActions(state: ControlState, deps: AppLifecycleDeps) {
  async function bootstrap() {
    try {
      const data = await api.bootstrap();
      state.inputs.value = data.inputs;
      state.models.value = data.models;
      state.archivedModels.value = data.archivedModels || [];
      state.prompts.value = data.prompts;
      state.references.value = data.references || [];
      const inputIds = new Set(state.inputs.value.map((i) => i.id));
      state.sessionInputIds.value = state.sessionInputIds.value.filter((id) => inputIds.has(id));
      // Inputs are never preselected: screenshots outlive a session on disk, so a
      // remembered tick would quietly re-run (and re-bill) yesterday's input.
      state.selInputs.value = [];
      // Everything else the user picked is remembered per-browser and only
      // *reconciled* here — a model that lost its keys or a prompt that was deleted
      // drops out, the rest of the selection survives the reload.
      // Reconcile against a catalog we actually got. A 200 that came back with an
      // empty catalog (a server mid-reload) must never be treated as "every model
      // you picked is gone" — that would persist an empty selection permanently.
      if (data.models.length) {
        const runnableIds = new Set(data.models.filter(isRunnable).map((m) => m.id));
        if (!state.selectionSeeded.value) {
          // First ever load on this browser: keep the original "everything runnable".
          state.selModels.value = [...runnableIds];
          state.selectionSeeded.value = true;
        } else {
          state.selModels.value = state.selModels.value.filter((id) => runnableIds.has(id));
        }
        // Quantities for models that are gone would silently inflate a later estimate.
        const modelIds = new Set(data.models.map((m) => m.id));
        for (const id of Object.keys(state.modelQty.value)) {
          if (!modelIds.has(id)) delete state.modelQty.value[id];
        }
      }
      if (state.prompts.value.length) {
        const promptIds = new Set(state.prompts.value.map((p) => p.id));
        state.selPrompts.value = state.selPrompts.value.filter((id) => promptIds.has(id));
      }
      // keep a still-valid reference selection across refreshes; drop missing ones
      const refIds = new Set(state.references.value.map((r) => r.id));
      state.selReference.value = state.selReference.value.filter((id) => refIds.has(id));
      if (!state.selReference.value.length) state.referenceOn.value = false;
      state.keys.value = data.keys;
      state.runs.value = data.runs || [];
      state.spend.value = data.spend || null;
      state.providerDefaults.value = data.providerDefaults || {};
      // The server keeps generating with the tab closed; pick those runs back up.
      void deps.resumeRuns();
      if (!appOpenedPulsed) {
        appOpenedPulsed = true;
        void recordPulse('app_opened');
      }
      void deps.checkForUpdate();
    } catch (e) {
      toast.error(t('actions.loadFailed'), { description: errMessage(e) });
    }
  }

  async function recordPulse(event: string, properties?: Record<string, unknown>) {
    try {
      await api.recordPulse(event, properties);
    } catch {
      /* pulse is non-critical */
    }
  }

  async function shutdownServer() {
    try {
      await api.shutdownServer();
      toast.success(t('actions.shuttingDown'));
      return true;
    } catch (e) {
      if (e instanceof TypeError) {
        toast(t('actions.shutdownRequested'));
        return true;
      }
      toast.error(t('actions.shutdownFailed'), { description: errMessage(e) });
      return false;
    }
  }

  return { bootstrap, recordPulse, shutdownServer };
}

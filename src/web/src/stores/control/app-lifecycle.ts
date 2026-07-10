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
      // defaults: NO inputs or prompts preselected, all runnable models
      state.selInputs.value = [];
      state.selModels.value = data.models.filter(isRunnable).map((m) => m.id);
      state.selPrompts.value = [];
      // keep a still-valid reference selection across refreshes; drop missing ones
      const refIds = new Set(state.references.value.map((r) => r.id));
      state.selReference.value = state.selReference.value.filter((id) => refIds.has(id));
      state.keys.value = data.keys;
      state.runs.value = data.runs || [];
      state.spend.value = data.spend || null;
      state.providerDefaults.value = data.providerDefaults || {};
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

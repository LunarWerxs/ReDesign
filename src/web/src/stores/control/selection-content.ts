import { toast } from 'vue-sonner';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import { filesToUploadImages, uploadableImageFiles } from '@/composables/useImageUpload';
import { toggleIn } from '@/lib/array';
import type { Prompt } from '@/types';
import { errMessage } from './state';
import type { ControlState } from './state';

export function createSelectionContentActions(state: ControlState) {
  function toggleInput(id: string) {
    state.selInputs.value = toggleIn(state.selInputs.value, id);
  }
  function toggleModel(id: string) {
    state.selModels.value = toggleIn(state.selModels.value, id);
  }
  function togglePrompt(id: string) {
    state.selPrompts.value = toggleIn(state.selPrompts.value, id);
  }
  function toggleReference(id: string) {
    state.selReference.value = toggleIn(state.selReference.value, id);
  }

  function selectAll(kind: 'inputs' | 'models' | 'prompts') {
    if (kind === 'inputs') state.selInputs.value = state.inputs.value.map((i) => i.id);
    else if (kind === 'models') state.selModels.value = [...state.runnableModelIds.value];
    else state.selPrompts.value = state.prompts.value.map((p) => p.id);
  }
  function selectNone(kind: 'inputs' | 'models' | 'prompts') {
    if (kind === 'inputs') state.selInputs.value = [];
    else if (kind === 'models') state.selModels.value = [];
    else state.selPrompts.value = [];
  }

  function reconcilePromptSelection(nextPrompts: Prompt[]) {
    const ids = new Set(nextPrompts.map((p) => p.id));
    state.selPrompts.value = state.selPrompts.value.filter((id) => ids.has(id));
  }

  async function uploadFiles(files: FileList | File[] | null, source = 'screenshot') {
    const accepted = uploadableImageFiles(files);
    if (!accepted.length) {
      toast(t('content.dropHint'));
      return;
    }
    try {
      const images = await filesToUploadImages(accepted, source);
      const r = await api.uploadInputs(images);
      state.inputs.value = r.inputs || [];
      const ids = new Set(state.inputs.value.map((it) => it.id));
      const addedIds = (r.addedIds || []).filter((id) => ids.has(id));
      state.sessionInputIds.value = Array.from(
        new Set([...state.sessionInputIds.value.filter((id) => ids.has(id)), ...addedIds]),
      );
      state.selInputs.value = addedIds.length
        ? addedIds
        : state.selInputs.value.filter((id) => ids.has(id));
      const n = (r.saved || []).length || accepted.length;
      toast.success(t('content.added', { count: n }, n));
    } catch (e) {
      toast.error(t('content.uploadFailed'), { description: errMessage(e) });
    }
  }

  async function deleteInput(id: string) {
    try {
      const r = await api.deleteInput(id);
      state.inputs.value = r.inputs || [];
      const ids = new Set(state.inputs.value.map((it) => it.id));
      state.sessionInputIds.value = state.sessionInputIds.value.filter((x) => ids.has(x));
      state.selInputs.value = state.selInputs.value.filter((x) => ids.has(x));
      toast.success(t('content.removed'));
    } catch (e) {
      toast.error(t('content.removeFailed'), { description: errMessage(e) });
    }
  }

  async function savePrompt(prompt: { id?: string; label: string; description?: string; user: string }) {
    const wasNew = !prompt.id;
    try {
      const r = await api.savePrompt(prompt);
      state.prompts.value = r.prompts || [];
      if (wasNew && r.prompt && !state.selPrompts.value.includes(r.prompt.id)) {
        state.selPrompts.value = [...state.selPrompts.value, r.prompt.id];
      } else {
        reconcilePromptSelection(state.prompts.value);
      }
      toast.success(wasNew ? t('prompts.added') : t('prompts.updated'));
      return r.prompt;
    } catch (e) {
      toast.error(t('prompts.saveFailed'), { description: errMessage(e) });
      return null;
    }
  }

  async function deletePrompt(id: string) {
    try {
      const r = await api.deletePrompt(id);
      state.prompts.value = r.prompts || [];
      reconcilePromptSelection(state.prompts.value);
      toast.success(t('prompts.removed'));
      return true;
    } catch (e) {
      toast.error(t('prompts.removeFailed'), { description: errMessage(e) });
      return false;
    }
  }

  async function restoreDefaultPrompts() {
    try {
      const r = await api.restoreDefaultPrompts();
      state.prompts.value = r.prompts || [];
      reconcilePromptSelection(state.prompts.value);
      toast.success(t('prompts.restored'));
      return true;
    } catch (e) {
      toast.error(t('prompts.restoreFailed'), { description: errMessage(e) });
      return false;
    }
  }

  return {
    toggleInput,
    toggleModel,
    togglePrompt,
    toggleReference,
    selectAll,
    selectNone,
    uploadFiles,
    deleteInput,
    savePrompt,
    deletePrompt,
    restoreDefaultPrompts,
  };
}

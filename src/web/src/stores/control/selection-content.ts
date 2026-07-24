import { toast } from 'vue-sonner';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import { filesToUploadImages, uploadableImageFiles } from '@/composables/useImageUpload';
import { readTextAttachment, textAttachableFiles } from '@/composables/useTextAttachments';
import { toggleIn } from '@/lib/array';
import type { BrandAttachment, Prompt } from '@/types';
import { errMessage } from './state';
import type { ControlState } from './state';

let brandAttachmentSeq = 0;
function nextBrandAttachmentId(): string {
  brandAttachmentSeq += 1;
  return `brand-attachment-${Date.now()}-${brandAttachmentSeq}`;
}

export function createSelectionContentActions(state: ControlState) {
  function toggleInput(id: string) {
    state.selInputs.value = toggleIn(state.selInputs.value, id);
  }
  function toggleModel(id: string) {
    const next = toggleIn(state.selModels.value, id);
    state.selModels.value = next;
    // Drop a deselected model's quantity so it can't linger in the payload/estimate.
    if (!next.includes(id) && state.modelQty.value[id] != null) {
      const { [id]: _dropped, ...rest } = state.modelQty.value;
      state.modelQty.value = rest;
    }
  }

  // Per-model copy count (1..10). Store only values > 1; a quantity of 1 is the
  // default and is represented by the model's absence from the map.
  function setModelQty(id: string, value: unknown) {
    const q = Math.max(1, Math.min(10, Math.round(Number(value) || 1)));
    if (q <= 1) {
      if (state.modelQty.value[id] != null) {
        const { [id]: _dropped, ...rest } = state.modelQty.value;
        state.modelQty.value = rest;
      }
      return;
    }
    state.modelQty.value = { ...state.modelQty.value, [id]: q };
  }
  function togglePrompt(id: string) {
    state.selPrompts.value = toggleIn(state.selPrompts.value, id);
  }
  function toggleReference(id: string) {
    state.selReference.value = toggleIn(state.selReference.value, id);
  }

  function selectAll(kind: 'inputs' | 'models' | 'prompts' | 'reference') {
    if (kind === 'inputs') state.selInputs.value = state.inputs.value.map((i) => i.id);
    else if (kind === 'models') state.selModels.value = [...state.runnableModelIds.value];
    else if (kind === 'reference') state.selReference.value = state.references.value.map((r) => r.id);
    else state.selPrompts.value = state.prompts.value.map((p) => p.id);
  }
  function selectNone(kind: 'inputs' | 'models' | 'prompts' | 'reference') {
    if (kind === 'inputs') state.selInputs.value = [];
    else if (kind === 'models') {
      state.selModels.value = [];
      state.modelQty.value = {};
    } else if (kind === 'reference') state.selReference.value = [];
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

  async function uploadReferences(files: FileList | File[] | null, source = 'reference') {
    const accepted = uploadableImageFiles(files);
    if (!accepted.length) {
      toast(t('content.dropHint'));
      return;
    }
    try {
      const images = await filesToUploadImages(accepted, source);
      const r = await api.uploadReferences(images);
      state.references.value = r.references || [];
      const ids = new Set(state.references.value.map((it) => it.id));
      const addedIds = (r.addedIds || []).filter((id) => ids.has(id));
      if (addedIds.length) {
        state.selReference.value = Array.from(new Set([...state.selReference.value, ...addedIds]));
      }
      const n = (r.saved || []).length || accepted.length;
      toast.success(t('content.added', { count: n }, n));
    } catch (e) {
      toast.error(t('content.uploadFailed'), { description: errMessage(e) });
    }
  }

  async function addBrandAttachments(files: FileList | File[] | null) {
    const accepted = textAttachableFiles(files);
    if (!accepted.length) {
      toast(t('options.brandAttachmentsDropHint'));
      return;
    }
    try {
      const read = await Promise.all(accepted.map((file) => readTextAttachment(file)));
      const added: BrandAttachment[] = read.map((r) => ({ id: nextBrandAttachmentId(), ...r }));
      state.brandAttachments.value = [...state.brandAttachments.value, ...added];
      if (added.some((a) => a.truncated)) toast(t('options.brandAttachmentTruncated'));
      toast.success(t('options.brandAttachmentsAdded', { count: added.length }, added.length));
    } catch (e) {
      toast.error(t('content.uploadFailed'), { description: errMessage(e) });
    }
  }

  function removeBrandAttachment(id: string) {
    state.brandAttachments.value = state.brandAttachments.value.filter((a) => a.id !== id);
  }

  function saveBrandStyleGuideDefault() {
    state.brandStyleGuideDefault.value = state.brandStyleGuide.value;
    toast.success(t('options.brandStyleGuideDefaultSaved'));
  }

  function clearBrandStyleGuideDefault() {
    state.brandStyleGuideDefault.value = '';
    toast.success(t('options.brandStyleGuideDefaultCleared'));
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

  // Toggle a prompt's picker "starred" flag. Silent on success (like models) so
  // rapid star/unstar doesn't spam toasts; the returned snapshot refreshes state.
  async function togglePromptStarred(id: string) {
    const current = state.prompts.value.find((p) => p.id === id);
    const nextStarred = !current?.starred;
    try {
      const r = await api.starPrompt(id, nextStarred);
      state.prompts.value = r.prompts || [];
      reconcilePromptSelection(state.prompts.value);
    } catch (e) {
      toast.error(t('prompts.starFailed'), { description: errMessage(e) });
    }
  }

  return {
    toggleInput,
    toggleModel,
    setModelQty,
    togglePrompt,
    toggleReference,
    selectAll,
    selectNone,
    uploadFiles,
    uploadReferences,
    addBrandAttachments,
    removeBrandAttachment,
    saveBrandStyleGuideDefault,
    clearBrandStyleGuideDefault,
    deleteInput,
    savePrompt,
    deletePrompt,
    restoreDefaultPrompts,
    togglePromptStarred,
  };
}

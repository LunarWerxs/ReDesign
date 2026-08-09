import { toast } from 'vue-sonner';
import { t } from '@/i18n';
import type { Manifest } from '@/types';
import type { ControlState } from './state';

/**
 * "Run again" (RunGallery.vue): prefill the control panel's selection state from a finished run's
 * manifest so the user only has to press Run, rather than re-ticking everything by hand.
 *
 * The staged manifest is applied AFTER Control.vue's own bootstrap() has re-synced the live
 * catalog, not before: bootstrap() unconditionally resets `selInputs` to `[]` on every mount
 * (inputs are deliberately never remembered, see state.ts) and reconciles `selModels`/`selPrompts`
 * against whatever it just fetched, so setting the selection ahead of that call would just get
 * wiped a beat later. `stageRunAgain` only remembers the manifest; `applyPendingRunAgain` (called
 * once bootstrap resolves) does the actual mapping.
 */
export function createRunAgainActions(state: ControlState) {
  let pending: Manifest | null = null;

  /** Called from RunGallery.vue right before it navigates to the control panel. */
  function stageRunAgain(manifest: Manifest): void {
    pending = manifest;
  }

  /**
   * Apply whatever was staged, once the live catalog is fresh. A no-op when nothing is staged —
   * the common case, every other Control mount — so this is safe to call unconditionally.
   */
  function applyPendingRunAgain(): void {
    const manifest = pending;
    pending = null;
    if (!manifest) return;
    const config = manifest.config;
    if (!config) {
      toast.error(t('runAgain.noConfig'));
      return;
    }
    const dropped: string[] = [];

    // Inputs: screenshots stay on disk, but the input may since have been removed.
    const inputIds = new Set(state.inputs.value.map((i) => i.id));
    const wantedInputs = config.inputIds || [];
    const keptInputs = wantedInputs.filter((id) => inputIds.has(id));
    if (keptInputs.length !== wantedInputs.length) dropped.push(t('runAgain.droppedInputs'));
    state.selInputs.value = keptInputs;

    // Models: the picker offers every model that still exists, runnable or not (a disabled one
    // just can't actually generate), so "still exists" is checked the same way here.
    const modelIds = new Set(state.models.value.map((m) => m.id));
    const wantedModels = config.modelIds || [];
    const keptModels = wantedModels.filter((id) => modelIds.has(id));
    if (keptModels.length !== wantedModels.length) dropped.push(t('runAgain.droppedModels'));
    state.selModels.value = keptModels;

    // Per-model copy count: variantsByModel overrides the flat `variants` default for that one
    // model (see runner/scheduling.ts); only carry an entry for a model that survived above, and
    // only when it generates more than the default single copy.
    const flatVariants = config.variants || 1;
    const nextQty: Record<string, number> = {};
    for (const id of keptModels) {
      const q = config.variantsByModel?.[id] ?? flatVariants;
      if (q > 1) nextQty[id] = q;
    }
    state.modelQty.value = nextQty;

    // Prompts: config.promptIds carries the pseudo id "custom" alongside real preset ids for a
    // one-off prompt (src/config/prompts.ts resolvePrompts) — its actual text lives on the
    // manifest's own `prompts` array instead, tagged source: 'custom'.
    const promptIds = new Set(state.prompts.value.map((p) => p.id));
    const wantedPromptIds = (config.promptIds || []).filter((id) => id !== 'custom');
    const keptPrompts = wantedPromptIds.filter((id) => promptIds.has(id));
    if (keptPrompts.length !== wantedPromptIds.length) dropped.push(t('runAgain.droppedPrompts'));
    state.selPrompts.value = keptPrompts;
    const customEntry = (manifest.prompts || []).find((p) => p.source === 'custom');
    state.customOn.value = !!customEntry?.user;
    state.custom.value = customEntry?.user || '';

    // Reference images: same "still on disk" gate as inputs. A reference item's id IS its
    // dir-relative path (src/inputResolver.ts listReferences), matching config.reference.images.
    const refIds = new Set(state.references.value.map((r) => r.id));
    const wantedRefs = config.reference?.images || [];
    const keptRefs = wantedRefs.filter((id) => refIds.has(id));
    if (keptRefs.length !== wantedRefs.length) dropped.push(t('runAgain.droppedReferences'));
    state.selReference.value = keptRefs;
    state.referenceOn.value = keptRefs.length > 0;
    state.refNote.value = config.reference?.note || '';

    // Brand style guide: recorded as one already-combined block of guide text + attachment text
    // (stores/control/runs.ts addToQueue), so there is no way to split attachments back out —
    // it lands as guide text alone, with no re-attached files.
    state.brandOn.value = !!config.brandStyleGuide;
    state.brandStyleGuide.value = config.brandStyleGuide || '';
    state.brandAttachments.value = [];

    if (dropped.length) {
      toast(t('runAgain.prefilled'), { description: t('runAgain.droppedSummary', { items: dropped.join(', ') }) });
    } else {
      toast.success(t('runAgain.prefilled'));
    }
  }

  return { stageRunAgain, applyPendingRunAgain };
}

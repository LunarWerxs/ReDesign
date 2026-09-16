import { toast } from 'vue-sonner';
import { t } from '@/i18n';
import type { Manifest, ManifestConfig } from '@/types';
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
    // One group per independently-gated set of fields; each appends its own "not found"
    // note to `dropped`, which is why the accumulator is threaded through them rather than
    // returned. Same order as the toasts below, same order as the fields were submitted in.
    const dropped: string[] = [];
    applyStagedInputs(state, config, dropped);
    applyStagedModels(state, config, dropped);
    applyStagedPrompts(state, manifest, config, dropped);
    applyStagedReferences(state, config, dropped);
    applyStagedBrand(state, config);
    applyStagedCostCeiling(state, config);

    if (dropped.length) {
      toast(t('runAgain.prefilled'), { description: t('runAgain.droppedSummary', { items: dropped.join(', ') }) });
    } else {
      toast.success(t('runAgain.prefilled'));
    }
  }

  return { stageRunAgain, applyPendingRunAgain };
}

// ── Manifest → control panel mapping ─────────────────────────────────────────
// The helpers behind applyPendingRunAgain. Each accepts the live state, the staged
// manifest's config (or manifest), and the `dropped` accumulator above.

function applyStagedInputs(state: ControlState, config: ManifestConfig, dropped: string[]): void {
  // Inputs: screenshots stay on disk, but the input may since have been removed.
  const inputIds = new Set(state.inputs.value.map((i) => i.id));
  const wanted = config.inputIds || [];
  const kept = wanted.filter((id) => inputIds.has(id));
  if (kept.length !== wanted.length) dropped.push(t('runAgain.droppedInputs'));
  state.selInputs.value = kept;
}

function applyStagedModels(state: ControlState, config: ManifestConfig, dropped: string[]): void {
  // A historical model may still exist while disabled or out of keys. Carrying it through makes
  // the prefill promise more work than the server can run, so use the picker/run predicate.
  const modelIds = new Set(state.runnableModelIds.value);
  const wanted = config.modelIds || [];
  const kept = wanted.filter((id) => modelIds.has(id));
  if (kept.length !== wanted.length) dropped.push(t('runAgain.droppedModels'));
  state.selModels.value = kept;

  // Per-model copy count: variantsByModel overrides the flat `variants` default for that one
  // model (see runner/scheduling.ts); only carry an entry for a model that survived above, and
  // only when it generates more than the default single copy.
  state.modelQty.value = stagedModelQuantities(config, kept);
}

/** Per-model copy counts for the models that survived reconciliation, the default of 1 omitted. */
function stagedModelQuantities(config: ManifestConfig, keptModels: string[]): Record<string, number> {
  const flatVariants = config.variants || 1;
  const nextQty: Record<string, number> = {};
  for (const id of keptModels) {
    const q = config.variantsByModel?.[id] ?? flatVariants;
    if (q > 1) nextQty[id] = q;
  }
  return nextQty;
}

function applyStagedPrompts(
  state: ControlState,
  manifest: Manifest,
  config: ManifestConfig,
  dropped: string[],
): void {
  // The generated one-off prompt can be named custom, custom-2, etc. Exclude only IDs which
  // this manifest itself marks as source: custom; a saved preset may legitimately use any of
  // those IDs and must remain selected.
  const promptIds = new Set(state.prompts.value.map((p) => p.id));
  const syntheticPromptIds = new Set(
    (manifest.prompts || []).filter((p) => p.source === 'custom').map((p) => p.id),
  );
  const wanted = (config.promptIds || []).filter((id) => !syntheticPromptIds.has(id));
  const kept = wanted.filter((id) => promptIds.has(id));
  if (kept.length !== wanted.length) dropped.push(t('runAgain.droppedPrompts'));
  state.selPrompts.value = kept;
  const customEntry = (manifest.prompts || []).find((p) => p.source === 'custom');
  state.customOn.value = !!customEntry?.user;
  state.custom.value = customEntry?.user || '';
}

function applyStagedReferences(state: ControlState, config: ManifestConfig, dropped: string[]): void {
  // Reference images: same "still on disk" gate as inputs. A reference item's id IS its
  // dir-relative path (src/inputResolver.ts listReferences), matching config.reference.images.
  const refIds = new Set(state.references.value.map((r) => r.id));
  const wanted = config.reference?.images || [];
  const kept = wanted.filter((id) => refIds.has(id));
  if (kept.length !== wanted.length) dropped.push(t('runAgain.droppedReferences'));
  state.selReference.value = kept;
  state.referenceOn.value = kept.length > 0;
  state.refNote.value = config.reference?.note || '';
}

function applyStagedBrand(state: ControlState, config: ManifestConfig): void {
  // Brand style guide: recorded as one already-combined block of guide text + attachment text
  // (stores/control/runs.ts addToQueue), so there is no way to split attachments back out —
  // it lands as guide text alone, with no re-attached files.
  state.brandOn.value = !!config.brandStyleGuide;
  state.brandStyleGuide.value = config.brandStyleGuide || '';
  state.brandAttachments.value = [];
}

function applyStagedCostCeiling(state: ControlState, config: ManifestConfig): void {
  // Preserve an original optional ceiling exactly when it was recorded. A missing legacy
  // value clears the field rather than silently applying this browser's unrelated old limit.
  state.maxCostUsd.value =
    typeof config.maxCostUsd === 'number' && Number.isFinite(config.maxCostUsd) && config.maxCostUsd >= 0
      ? String(config.maxCostUsd)
      : '';
}

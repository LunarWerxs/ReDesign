import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import { t } from '@/i18n';

/**
 * Rolling cross-run star tally, persisted in localStorage (survives the per-run
 * `starredItems` prune in the viewer store, see stores/viewer.ts). Records which
 * model's output was starred FIRST in a run, one entry per run, capped to the
 * last 20 runs so the readout stays "recent form" rather than all-time trivia.
 */
export interface StarTallyEntry {
  runId: string;
  model: string;
}

const MAX_ENTRIES = 20;
export const STAR_TALLY_STORAGE_KEY = 'reimagine.starTally';

const entries = useStorage<StarTallyEntry[]>(STAR_TALLY_STORAGE_KEY, []);

/**
 * Record the first star of `runId` landing on `model`. No-op if this run already
 * has an entry (dedupe by runId, later stars in the same run don't move the tally).
 */
export function recordFirstStar(runId: string, model: string) {
  if (!runId || !model) return;
  if (entries.value.some((e) => e.runId === runId)) return;
  const next = [...entries.value, { runId, model }];
  entries.value = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

/** True once `runId` already has a recorded first star (so callers can skip re-checking). */
export function hasFirstStar(runId: string): boolean {
  return entries.value.some((e) => e.runId === runId);
}

export const starTallyEntries = computed(() => entries.value);

/** Unobtrusive readout: "{model} starred first in {n} of your last {total} runs." */
export const starTallyReadout = computed(() => {
  const list = entries.value;
  if (!list.length) return null;
  const counts = new Map<string, number>();
  for (const e of list) counts.set(e.model, (counts.get(e.model) || 0) + 1);
  let topModel = list[0]!.model;
  let topCount = 0;
  for (const [model, count] of counts) {
    if (count > topCount) {
      topModel = model;
      topCount = count;
    }
  }
  return t('viewer.starTally', { model: topModel, count: topCount, total: list.length });
});

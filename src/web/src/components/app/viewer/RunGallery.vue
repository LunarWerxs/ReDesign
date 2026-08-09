<script setup lang="ts">
/**
 * The viewer's landing surface: every past run as a thumbnail of the screenshot it started
 * from. Shown whenever the viewer is opened WITHOUT a ?run= (see pages/Viewer.vue) — arriving
 * at the viewer with nothing generated this session used to silently reopen whatever run
 * happened to be newest, which is a decision the owner never made. Pick one here instead.
 *
 * The thumbnail is the "before" image — what a run is actually recognisable by. It's served by a
 * single endpoint (api.runThumbnailUrl → /api/runs/:id/thumbnail) that owns the whole fallback
 * chain server-side: the run's saved thumb, else its surviving input screenshot, else a freshly
 * rendered output preview (see src/thumbnail.ts), else 404. A 404 shows the placeholder; while the
 * server is rendering an old run's preview the card shows a spinner. Immutable-cached, so each
 * thumbnail is fetched (and rendered) at most once.
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import {
  CheckIcon,
  CheckSquare2Icon,
  ImageOffIcon,
  Loader2Icon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from '@lucide/vue';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, runThumbnailUrl } from '@/lib/api';
import { formatAgo } from '@/lib/relativeTime';
import { useViewerStore } from '@/stores/viewer';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { RunSummary } from '@/types';

const store = useViewerStore();
const controlStore = useControlStore();
const router = useRouter();

// Stamped once on setup: a reactive clock here would re-render every card on a timer for a
// readout that only ever needs to be roughly right.
const now = ref(Date.now());

// Hide FINISHED runs that produced nothing (total 0): a cancelled-before-it-started or empty test
// run has no outputs to open and no image to show, so it's pure noise in a gallery. Active
// (queued/running) runs stay visible even at 0 — they just haven't produced yet.
function isEmptyFinished(run: RunSummary) {
  if (run.status === 'queued' || run.status === 'running') return false;
  const total = run.total ?? run.counts?.total ?? 0;
  return total === 0 && !(run.counts?.ok || 0);
}
const runs = computed(() => store.runs.filter((r) => !isEmptyFinished(r)));

// Filters the gallery by run title or run id substring — an old run is otherwise findable only
// by scrolling. Kept separate from `runs` above: selection state (deletableRuns, the "select
// all" toolbar, the watch that prunes stale selections) stays anchored to the full list so
// typing into the search box never silently drops an in-progress multi-select.
const search = ref('');
const filteredRuns = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return runs.value;
  return runs.value.filter(
    (run) => runTitle(run).toLowerCase().includes(q) || run.runId.toLowerCase().includes(q),
  );
});

const selectionMode = ref(false);
const selectedRunIds = ref<string[]>([]);
const selectedSet = computed(() => new Set(selectedRunIds.value));
const deletableRuns = computed(() => runs.value.filter(canDelete));
const allSelected = computed(
  () =>
    !!deletableRuns.value.length &&
    deletableRuns.value.every((run) => selectedSet.value.has(run.runId)),
);

function runTitle(run: RunSummary) {
  return run.title || run.summary?.title || run.runId;
}

function runTally(run: RunSummary) {
  if (run.status === 'queued') return t('runFlyout.queued');
  const ok = run.counts?.ok || 0;
  const total = run.total ?? run.counts?.total ?? 0;
  return `${ok}/${total}`;
}

function runAgo(run: RunSummary) {
  const at = run.createdAt ? new Date(run.createdAt).getTime() : Number.NaN;
  return Number.isFinite(at) ? formatAgo(now.value, at, t) : null;
}

function canDelete(run: RunSummary) {
  return run.status !== 'queued' && run.status !== 'running';
}

function cardTitle(run: RunSummary) {
  if (!selectionMode.value) return t('runGallery.openRun', { title: runTitle(run) });
  if (!canDelete(run)) return t('runGallery.activeRunCannotDelete');
  return isSelected(run.runId)
    ? t('runGallery.deselectRun', { title: runTitle(run) })
    : t('runGallery.selectRun', { title: runTitle(run) });
}

// Per-run load state for the single thumbnail endpoint: a spinner until it loads, the placeholder
// if it 404s (nothing renderable). The endpoint may take a few seconds the first time it renders
// an old run's output preview, hence the spinner rather than a blank card.
const thumbUrl = (run: RunSummary) => runThumbnailUrl(run.runId);
const loaded = ref(new Set<string>());
const broken = ref(new Set<string>());
const isLoaded = (run: RunSummary) => loaded.value.has(run.runId);
const isBroken = (run: RunSummary) => broken.value.has(run.runId);
function onThumbLoad(run: RunSummary) {
  loaded.value = new Set(loaded.value).add(run.runId);
}
function onThumbError(run: RunSummary) {
  broken.value = new Set(broken.value).add(run.runId);
}

function open(runId: string) {
  void router.push({ path: '/viewer', query: { run: runId } });
}

// Track in-flight fetches so a fast double-click can't fire the same request twice.
const runningAgainIds = ref(new Set<string>());

/**
 * Prefill the control panel from this finished run and jump to it — the user still presses Run
 * (see stores/control/run-again.ts, which does the actual mapping once bootstrap() has re-synced
 * the live catalog on the other side of the navigation).
 */
async function runAgain(run: RunSummary) {
  if (runningAgainIds.value.has(run.runId)) return;
  runningAgainIds.value = new Set(runningAgainIds.value).add(run.runId);
  try {
    const manifest = await api.run(run.runId);
    controlStore.stageRunAgain(manifest);
    void router.push('/');
  } catch (e) {
    toast.error(t('runGallery.runAgainFailed'), { description: e instanceof Error ? e.message : String(e) });
  } finally {
    const next = new Set(runningAgainIds.value);
    next.delete(run.runId);
    runningAgainIds.value = next;
  }
}

function isSelected(runId: string) {
  return selectedSet.value.has(runId);
}

function toggleSelection(run: RunSummary) {
  if (!canDelete(run) || store.deletingRunIds.has(run.runId)) return;
  selectedRunIds.value = isSelected(run.runId)
    ? selectedRunIds.value.filter((id) => id !== run.runId)
    : [...selectedRunIds.value, run.runId];
}

function activate(run: RunSummary) {
  if (selectionMode.value) {
    toggleSelection(run);
    return;
  }
  open(run.runId);
}

function beginSelection() {
  selectionMode.value = true;
  selectedRunIds.value = [];
}

function cancelSelection() {
  selectionMode.value = false;
  selectedRunIds.value = [];
}

function toggleAllSelection() {
  selectedRunIds.value = allSelected.value
    ? []
    : deletableRuns.value.map((run) => run.runId);
}

const deleteConfirmOpen = ref(false);
const pendingDeleteIds = ref<string[]>([]);
const pendingDeleteTitle = computed(() => {
  if (pendingDeleteIds.value.length !== 1) return t('runFlyout.deleteSelectedRunsTitle');
  const run = runs.value.find((item) => item.runId === pendingDeleteIds.value[0]);
  return t('runGallery.deleteRunTitle', { title: run ? runTitle(run) : pendingDeleteIds.value[0] });
});
const pendingDeleteDescription = computed(() =>
  t(
    'runFlyout.deleteConfirmDescription',
    { count: pendingDeleteIds.value.length },
    pendingDeleteIds.value.length,
  ),
);

function requestDelete(ids: string[]) {
  const allowed = new Set(deletableRuns.value.map((run) => run.runId));
  pendingDeleteIds.value = Array.from(new Set(ids)).filter((id) => allowed.has(id));
  if (pendingDeleteIds.value.length) deleteConfirmOpen.value = true;
}

async function confirmDelete() {
  const ids = [...pendingDeleteIds.value];
  if (!ids.length) return;
  const result = await store.deleteRuns(ids);
  if (!result) return;
  const stillSelectable = new Set(deletableRuns.value.map((run) => run.runId));
  selectedRunIds.value = selectedRunIds.value.filter((id) => stillSelectable.has(id));
  if (!selectedRunIds.value.length) selectionMode.value = false;
  pendingDeleteIds.value = [];
}

watch(
  () => runs.value.map((run) => run.runId),
  (ids) => {
    const current = new Set(ids);
    selectedRunIds.value = selectedRunIds.value.filter((id) => current.has(id));
    if (!ids.length) selectionMode.value = false;
  },
);
</script>

<template>
  <div class="p-[18px]">
    <div class="mb-4 flex min-h-8 items-center gap-2">
      <div class="flex items-baseline gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {{ t('runGallery.title') }}
        </h2>
        <span v-if="runs.length" class="text-xs text-muted-foreground/70">{{ runs.length }}</span>
      </div>

      <div v-if="runs.length" class="ml-auto flex items-center gap-1.5">
        <template v-if="selectionMode">
          <span class="mr-1 text-xs text-muted-foreground">
            {{ t('runFlyout.selectedCount', { count: selectedRunIds.length }, selectedRunIds.length) }}
          </span>
          <Button
            variant="ghost"
            size="xs"
            :disabled="!deletableRuns.length"
            @click="toggleAllSelection"
          >
            {{ allSelected ? t('runFlyout.none') : t('runFlyout.all') }}
          </Button>
          <Button variant="ghost" size="xs" @click="cancelSelection">
            <XIcon class="size-3.5" />
            {{ t('runFlyout.cancel') }}
          </Button>
          <Button
            variant="destructive"
            size="xs"
            :disabled="!selectedRunIds.length"
            @click="requestDelete(selectedRunIds)"
          >
            <Trash2Icon class="size-3.5" />
            {{ t('runFlyout.delete') }}
          </Button>
        </template>
        <Button
          v-else
          variant="outline"
          size="xs"
          :disabled="!deletableRuns.length"
          @click="beginSelection"
        >
          <CheckSquare2Icon class="size-3.5" />
          {{ t('runGallery.select') }}
        </Button>
      </div>
    </div>

    <div v-if="runs.length" class="relative mb-4">
      <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="search" :placeholder="t('runGallery.searchPlaceholder')" class="h-8 pl-8" />
    </div>

    <p v-if="!runs.length" class="py-16 text-center text-sm text-muted-foreground">
      {{ t('runGallery.empty') }}
    </p>
    <p v-else-if="!filteredRuns.length" class="py-16 text-center text-sm text-muted-foreground">
      {{ t('runGallery.noMatches') }}
    </p>

    <div
      v-else
      class="grid gap-[18px]"
      style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))"
    >
      <div
        v-for="run in filteredRuns"
        :key="run.runId"
        data-run-card
        :data-run-id="run.runId"
        class="group relative flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors focus-within:border-primary"
        :class="[
          isSelected(run.runId) ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'hover:border-primary/50',
          selectionMode && !canDelete(run) ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
        ]"
      >
        <button
          type="button"
          data-run-card-action
          class="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="selectionMode && !canDelete(run) ? 'cursor-not-allowed' : 'cursor-pointer'"
          :aria-label="cardTitle(run)"
          :aria-pressed="selectionMode ? isSelected(run.runId) : undefined"
          :aria-disabled="selectionMode && !canDelete(run) ? 'true' : undefined"
          :title="cardTitle(run)"
          @click="activate(run)"
        />

        <div class="relative aspect-[4/3] overflow-hidden bg-muted">
          <span
            v-if="selectionMode"
            class="pointer-events-none absolute left-2 top-2 z-20 grid size-4 place-items-center rounded-[4px] border bg-background shadow-sm"
            :class="
              isSelected(run.runId)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input'
            "
            aria-hidden="true"
          >
            <CheckIcon v-if="isSelected(run.runId)" class="size-3" />
          </span>

          <div
            v-else-if="canDelete(run)"
            class="absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  data-run-again
                  variant="outline"
                  size="icon-sm"
                  class="bg-background/90 text-foreground shadow-sm backdrop-blur hover:bg-accent"
                  :disabled="runningAgainIds.has(run.runId)"
                  :aria-label="t('runGallery.runAgain', { title: runTitle(run) })"
                  @click.stop="runAgain(run)"
                  @keydown.stop
                >
                  <Loader2Icon v-if="runningAgainIds.has(run.runId)" class="size-4 animate-spin" />
                  <RotateCcwIcon v-else class="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('runGallery.runAgain', { title: runTitle(run) }) }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  data-run-delete
                  variant="outline"
                  size="icon-sm"
                  class="bg-background/90 text-destructive shadow-sm backdrop-blur hover:bg-destructive hover:text-destructive-foreground"
                  :aria-label="t('runGallery.deleteRun', { title: runTitle(run) })"
                  @click.stop="requestDelete([run.runId])"
                  @keydown.stop
                >
                  <Trash2Icon class="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('runGallery.deleteRun', { title: runTitle(run) }) }}</TooltipContent>
            </Tooltip>
          </div>

          <!-- Spinner / placeholder sit BEHIND the image as absolute layers. The image itself is
               never display:none (no v-show): a `loading="lazy"` img with display:none has no
               layout box, so the browser's lazy-loader never fires it — it can't load because it's
               hidden and it's hidden because it hasn't loaded. Kept in flow, it lazy-loads normally
               and simply paints over the spinner once it arrives. -->
          <div
            v-if="!isLoaded(run) && !isBroken(run)"
            class="absolute inset-0 grid place-items-center text-muted-foreground/40"
          >
            <Loader2Icon class="size-6 animate-spin" />
          </div>
          <div
            v-else-if="isBroken(run)"
            class="absolute inset-0 grid place-items-center text-muted-foreground/40"
          >
            <ImageOffIcon class="size-8" />
          </div>
          <!-- Fades in on load (opacity 0 → 100) so a thumbnail arriving mid-scroll eases in
               rather than popping. The transform transition stays for the hover zoom. -->
          <img
            v-if="!isBroken(run)"
            :src="thumbUrl(run)"
            alt=""
            loading="lazy"
            class="relative size-full object-cover object-top transition-[opacity,transform] duration-500 ease-out group-hover:scale-[1.03]"
            :class="isLoaded(run) ? 'opacity-100' : 'opacity-0'"
            @load="onThumbLoad(run)"
            @error="onThumbError(run)"
          />
          <Badge
            v-if="run.mock"
            variant="secondary"
            class="pointer-events-none absolute top-2 z-20"
            :class="selectionMode ? 'left-9' : 'left-2'"
          >
            {{ t('runFlyout.mockBadge') }}
          </Badge>
        </div>

        <div class="flex min-w-0 items-center gap-2 border-t px-3 py-2.5">
          <span class="grid min-w-0 flex-1 gap-px">
            <span class="truncate text-[13px] font-bold">{{ runTitle(run) }}</span>
            <span class="truncate text-[11px] text-muted-foreground/70">
              {{ runAgo(run) || run.runId }}
            </span>
          </span>
          <span class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon
              v-if="run.status === 'running' || run.status === 'queued'"
              class="size-3 animate-spin"
            />
            {{ runTally(run) }}
          </span>
        </div>
      </div>
    </div>
  </div>

  <AlertDialog v-model:open="deleteConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ pendingDeleteTitle }}</AlertDialogTitle>
        <AlertDialogDescription>{{ pendingDeleteDescription }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('runFlyout.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmDelete">
          {{ t('runFlyout.delete') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

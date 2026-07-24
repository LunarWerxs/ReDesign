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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ImageOffIcon, Loader2Icon } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { runThumbnailUrl } from '@/lib/api';
import { formatAgo } from '@/lib/relativeTime';
import { useViewerStore } from '@/stores/viewer';
import { t } from '@/i18n';
import type { RunSummary } from '@/types';

const store = useViewerStore();
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
  router.push({ path: '/viewer', query: { run: runId } });
}

function onKeydown(e: KeyboardEvent, runId: string) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  open(runId);
}
</script>

<template>
  <div class="p-[18px]">
    <div class="mb-4 flex items-baseline gap-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('runGallery.title') }}
      </h2>
      <span v-if="runs.length" class="text-xs text-muted-foreground/70">{{ runs.length }}</span>
    </div>

    <p v-if="!runs.length" class="py-16 text-center text-sm text-muted-foreground">
      {{ t('runGallery.empty') }}
    </p>

    <div
      v-else
      class="grid gap-[18px]"
      style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))"
    >
      <div
        v-for="run in runs"
        :key="run.runId"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/50 focus-visible:border-primary focus-visible:outline-none"
        :title="t('runGallery.openRun', { title: runTitle(run) })"
        @click="open(run.runId)"
        @keydown="onKeydown($event, run.runId)"
      >
        <div class="relative aspect-[4/3] overflow-hidden bg-muted">
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
          <Badge v-if="run.mock" variant="secondary" class="absolute left-2 top-2 z-10">
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
</template>

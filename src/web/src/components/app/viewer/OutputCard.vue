<script setup lang="ts">
import { CameraIcon, ContrastIcon, ExternalLinkIcon, DownloadIcon, EyeIcon, EyeOffIcon, FileTextIcon, LoaderCircleIcon, Maximize2Icon, StarIcon, XIcon } from '@lucide/vue';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { outputUrl, outputRawUrl, downloadUrl, screenshotUrl, designMdUrl, contrastUrl } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Job } from '@/types';
import type { ViewerHeight } from '@/stores/viewer';
import ScaledFrame from './ScaledFrame.vue';
import { t } from '@/i18n';

const props = defineProps<{
  job: Job;
  modelLabel: string;
  modelColor: string;
  promptLabel: string;
  rw: number;
  ar: number;
  height: ViewerHeight;
  scale: number;
  starred: boolean;
  itemHidden: boolean;
  /** The open run, so a chosen output can be handed off as a DESIGN.md; no button without it. */
  runId?: string;
  /** Shown full screen, one at a time: the `leading` slot carries the pager and X closes. */
  focused?: boolean;
}>();

defineEmits<{ (e: 'toggle-star'): void; (e: 'toggle-hidden'): void; (e: 'focus'): void; (e: 'close'): void }>();

const rawUrl = computed(() => outputRawUrl(props.job.file || '', { measure: props.height === 'auto' }));
// Distinct accessible name per iframe — see the comment on ScaledFrame's title prop.
const frameTitle = computed(() => `${props.modelLabel} — ${props.promptLabel}`);

// Server-side render-to-PNG (the sandboxed iframe is unreadable client-side); the fetch
// keeps a spinner on the button for the few seconds headless Chromium needs.
const shotBusy = ref(false);
async function takeScreenshot() {
  if (shotBusy.value || !props.job.file) return;
  shotBusy.value = true;
  try {
    const res = await fetch(screenshotUrl(props.job.file));
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(props.job.file.split('/').pop() || 'preview').replace(/\.html?$/i, '')}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast.error(t('viewer.screenshotFailed', { error: err instanceof Error ? err.message : String(err) }));
  } finally {
    shotBusy.value = false;
  }
}

// Anti-slop lint badge: the worst severity the server's rule table found in this output, with
// every finding in the tooltip, so a generic-looking redesign is flagged before anyone opens it.
const slopBadge = computed(() => {
  const slop = props.job.slop;
  if (!slop || !slop.findings.length) return null;
  const [severity, count, cls] =
    slop.p0 > 0 ? (['P0', slop.p0, 'border-destructive/50 text-destructive'] as const)
    : slop.p1 > 0 ? (['P1', slop.p1, 'border-warning/50 text-warning'] as const)
    : (['P2', slop.p2, 'text-muted-foreground'] as const);
  return { text: t('viewer.slopBadge', { severity, count }), cls };
});

const slopRetryText = computed(() => {
  const retry = props.job.slopRetry;
  if (!retry) return '';
  return retry.kept
    ? t('viewer.slopRetryKept', { before: retry.before.p0, after: retry.after?.p0 ?? 0 })
    : t('viewer.slopRetryDropped');
});

// WCAG text contrast judged from the rendered pixels (src/contrast.ts on the server), so a
// redesign with light text over a photo or gradient gets flagged on its card. On demand: each
// uncached check is a headless Chromium render, too heavy to fire for every card in a gallery.
interface ContrastReport {
  checked: number;
  failingCount: number;
  worstRatio: number | null;
  passes: boolean;
  failing: { text: string; ratio: number; required: number }[];
}
const contrastBusy = ref(false);
const contrast = ref<ContrastReport | null>(null);
async function checkContrast() {
  if (contrastBusy.value || !props.job.file) return;
  contrastBusy.value = true;
  try {
    const res = await fetch(contrastUrl(props.job.file));
    const body = (await res.json().catch(() => null)) as (ContrastReport & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error || `HTTP ${res.status}`);
    contrast.value = body;
  } catch (err) {
    toast.error(t('viewer.contrastFailed', { error: err instanceof Error ? err.message : String(err) }));
  } finally {
    contrastBusy.value = false;
  }
}
const contrastBadge = computed(() => {
  const r = contrast.value;
  if (!r) return null;
  if (!r.checked) return { label: t('viewer.contrastNoText'), title: t('viewer.contrastNoText'), fail: false };
  if (r.passes) return { label: t('viewer.contrastPass'), title: t('viewer.contrastPassTitle', { count: r.checked }), fail: false };
  // failing is sorted worst first; worstRatio spans every checked line, passing large text included.
  const worst = r.failing[0];
  return {
    label: t('viewer.contrastFail', { ratio: String(worst?.ratio ?? r.worstRatio ?? '') }),
    title: t('viewer.contrastFailTitle', { count: r.failingCount, text: worst?.text || '', ratio: String(worst?.ratio ?? ''), required: String(worst?.required ?? '') }),
    fail: true,
  };
});

// Full screen, each button names its key (OutputGrid.vue's keyboard handler) and hide reads as
// "mark bad", which is what culling with it means there.
const starLabel = computed(() => (props.starred ? t('viewer.unstarItem') : t('viewer.starItem')) + (props.focused ? ' (S)' : ''));
const openLabel = computed(() => t('viewer.openOutput') + (props.focused ? ' (O)' : ''));
const hideLabel = computed(() => {
  if (props.itemHidden) return t('viewer.restoreItem') + (props.focused ? ' (X)' : '');
  return props.focused ? t('viewer.markBad') : t('viewer.hideItem');
});

// A click inside the shown page hands the keyboard to that sandboxed frame. Moving the pointer
// off it hands the keyboard back, so the shortcuts work again without a click elsewhere.
function reclaimKeys() {
  if (props.focused && document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
}

const sub = () => {
  let s = props.promptLabel;
  if (props.job.variant > 1) s += ` · v${props.job.variant}`;
  if (props.job.truncated) s += ` · ${t('viewer.truncatedWarning')}`;
  if (props.job.wrapped) s += ` · ${t('viewer.wrappedWarning')}`;
  if (props.job.cost && props.job.cost.totalCost > 0) {
    const amount = props.job.cost.totalCost < 0.01 ? props.job.cost.totalCost.toFixed(4) : props.job.cost.totalCost.toFixed(2);
    s += ` · ${t('cost.actualCost', { amount })}`;
  }
  return s;
};
</script>

<template>
  <!-- never dimmed full screen: a see-through overlay would show the grid behind it, and the eye
       icon already says "hidden" there -->
  <div
    class="flex flex-col overflow-hidden transition-opacity"
    :class="[
      focused ? 'fixed inset-0 z-50 bg-background' : 'rounded-lg border bg-card',
      itemHidden && !focused ? 'opacity-50 grayscale' : '',
    ]"
  >
    <div class="flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5">
      <slot name="leading" />
      <span class="size-2.5 shrink-0 rounded-full bg-model-dot" :style="{ '--model-color': modelColor }" />
      <span class="min-w-0 truncate text-ui font-bold">{{ modelLabel }}</span>
      <span class="min-w-0 truncate text-xs text-muted-foreground">{{ sub() }}</span>
      <Tooltip v-if="slopBadge">
        <TooltipTrigger as-child>
          <span
            class="shrink-0 cursor-default rounded border px-1.5 text-2xs font-medium"
            :class="slopBadge.cls"
            tabindex="0"
            :aria-label="`${t('viewer.slopTitle')}: ${slopBadge.text}`"
          >{{ slopBadge.text }}</span>
        </TooltipTrigger>
        <TooltipContent class="max-w-xs">
          <div class="leading-snug">
            <p class="mb-1 font-bold">{{ t('viewer.slopTitle') }}</p>
            <ul class="space-y-0.5">
              <li v-for="(f, i) in job.slop?.findings ?? []" :key="i">{{ f.severity }} {{ f.rule }}: {{ f.message }}</li>
            </ul>
            <p v-if="slopRetryText" class="mt-1">{{ slopRetryText }}</p>
          </div>
        </TooltipContent>
      </Tooltip>
      <span class="flex-1" />
      <span
        v-if="contrastBadge"
        class="shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium"
        :class="contrastBadge.fail ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
        :title="contrastBadge.title"
      >{{ contrastBadge.label }}</span>
      <div class="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              :aria-label="starLabel"
              :aria-pressed="starred"
              @click.stop="$emit('toggle-star')"
            >
              <StarIcon class="size-3.5" :class="starred ? 'fill-current text-warning' : 'text-muted-foreground'" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ starLabel }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="icon-xs" :aria-label="openLabel">
              <a :href="outputUrl(job.file || '')" target="_blank" rel="noreferrer">
                <ExternalLinkIcon class="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ openLabel }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="icon-xs" :aria-label="t('viewer.downloadOutput')">
              <a :href="downloadUrl(job.file || '')">
                <DownloadIcon class="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.downloadOutput') }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="runId && /\.html?$/i.test(job.file || '')">
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="icon-xs" :aria-label="t('viewer.downloadDesignMd')">
              <a :href="designMdUrl(runId, String(job.id))">
                <FileTextIcon class="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.downloadDesignMd') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              :disabled="shotBusy"
              :aria-label="t('viewer.screenshotItem')"
              @click.stop="takeScreenshot"
            >
              <LoaderCircleIcon v-if="shotBusy" class="size-3.5 animate-spin text-muted-foreground" />
              <CameraIcon v-else class="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.screenshotItem') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              :disabled="contrastBusy"
              :aria-label="t('viewer.contrastItem')"
              @click.stop="checkContrast"
            >
              <LoaderCircleIcon v-if="contrastBusy" class="size-3.5 animate-spin text-muted-foreground" />
              <ContrastIcon v-else class="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.contrastItem') }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="!focused">
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('viewer.focusOpen')" @click.stop="$emit('focus')">
              <Maximize2Icon class="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.focusOpen') }}</TooltipContent>
        </Tooltip>
        <!-- the LAST control is an X at the top-right corner: hide on a card, back to the grid
             full screen (where hide moves one step left and becomes an eye) -->
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              :aria-label="hideLabel"
              :aria-pressed="itemHidden"
              @click.stop="$emit('toggle-hidden')"
            >
              <EyeIcon v-if="itemHidden" class="size-3.5 text-muted-foreground" />
              <EyeOffIcon v-else-if="focused" class="size-3.5 text-muted-foreground" />
              <XIcon v-else class="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ hideLabel }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="focused">
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('viewer.focusClose')" @click.stop="$emit('close')">
              <XIcon class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.focusClose') }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
    <ScaledFrame
      :raw-url="rawUrl"
      :title="frameTitle"
      :rw="rw"
      :ar="ar"
      :height="height"
      :scale="scale"
      :fill="focused"
      @pointerleave="reclaimKeys"
    />
    <slot name="footer" />
  </div>
</template>

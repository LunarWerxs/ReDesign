<script setup lang="ts">
import { CameraIcon, ContrastIcon, ExternalLinkIcon, DownloadIcon, EyeIcon, LoaderCircleIcon, StarIcon, XIcon } from '@lucide/vue';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { outputUrl, outputRawUrl, downloadUrl, screenshotUrl, contrastUrl } from '@/lib/api';
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
}>();

defineEmits<{ (e: 'toggle-star'): void; (e: 'toggle-hidden'): void }>();

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
  const worst = r.failing[0];
  return {
    label: t('viewer.contrastFail', { ratio: String(r.worstRatio ?? '') }),
    title: t('viewer.contrastFailTitle', { count: r.failingCount, text: worst?.text || '', ratio: String(worst?.ratio ?? ''), required: String(worst?.required ?? '') }),
    fail: true,
  };
});

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
  <div
    class="flex flex-col overflow-hidden rounded-lg border bg-card transition-opacity"
    :class="itemHidden ? 'opacity-50 grayscale' : ''"
  >
    <div class="flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5">
      <span class="size-2.5 shrink-0 rounded-full" :style="{ background: modelColor || '#888' }" />
      <span class="min-w-0 truncate text-[13px] font-bold">{{ modelLabel }}</span>
      <span class="min-w-0 truncate text-xs text-muted-foreground">{{ sub() }}</span>
      <span class="flex-1" />
      <span
        v-if="contrastBadge"
        class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
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
              :aria-label="starred ? t('viewer.unstarItem') : t('viewer.starItem')"
              :aria-pressed="starred"
              @click.stop="$emit('toggle-star')"
            >
              <StarIcon class="size-3.5" :class="starred ? 'fill-current text-warning' : 'text-muted-foreground'" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ starred ? t('viewer.unstarItem') : t('viewer.starItem') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="icon-xs" :aria-label="t('viewer.openOutput')">
              <a :href="outputUrl(job.file || '')" target="_blank" rel="noreferrer">
                <ExternalLinkIcon class="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('viewer.openOutput') }}</TooltipContent>
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
        <!-- hide ("close") stays the LAST control so the X sits at the card's top-right corner -->
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              :aria-label="itemHidden ? t('viewer.restoreItem') : t('viewer.hideItem')"
              :aria-pressed="itemHidden"
              @click.stop="$emit('toggle-hidden')"
            >
              <EyeIcon v-if="itemHidden" class="size-3.5 text-muted-foreground" />
              <XIcon v-else class="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ itemHidden ? t('viewer.restoreItem') : t('viewer.hideItem') }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
    <ScaledFrame :raw-url="rawUrl" :title="frameTitle" :rw="rw" :ar="ar" :height="height" :scale="scale" />
  </div>
</template>

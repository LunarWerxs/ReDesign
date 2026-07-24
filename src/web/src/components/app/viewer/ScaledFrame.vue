<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { useIframeScale } from '@/composables/useIframeScale';
import type { ViewerHeight } from '@/stores/viewer';

// rawUrl must point at /output-raw/<encPath> (server serves it with a CSP sandbox
// header). The iframe sandbox below intentionally OMITS allow-same-origin so
// model-generated HTML can never reach our origin or API.
const props = defineProps<{ rawUrl: string; rw: number; ar: number; height: ViewerHeight; scale: number }>();

const wrap = useTemplateRef<HTMLElement>('wrap');
const frame = useTemplateRef<HTMLIFrameElement>('frame');
const measuredHeight = ref<number | null>(null);
const frameActive = ref(false);
let visibilityObserver: IntersectionObserver | null = null;

const maxAutoHeight = 20000;

const resolvedHeight = computed(() => {
  if (typeof props.height === 'number') return props.height;
  if (props.height === 'auto') return measuredHeight.value;
  return null;
});
const previewScale = computed(() => Math.max(0.1, props.scale || 1));
const frameAspect = computed(() => {
  const h = resolvedHeight.value;
  return props.rw && h && h > 0 ? props.rw / (h * previewScale.value) : props.ar / previewScale.value;
});

function onFrameMessage(event: MessageEvent) {
  if (props.height !== 'auto' || event.source !== frame.value?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'reimagine:frame-height') return;
  const h = Math.round(Number(data.height));
  if (!Number.isFinite(h) || h <= 0) return;
  measuredHeight.value = Math.min(maxAutoHeight, Math.max(Math.ceil(props.rw / props.ar), h));
}

onMounted(() => {
  window.addEventListener('message', onFrameMessage);
  // `loading="lazy"` still creates hundreds of iframe browsing contexts for a large run.
  // Keep only previews near the viewport alive; far-away cards retain their exact layout and
  // cached measured height, but release the iframe's document/script/memory until needed.
  if (typeof IntersectionObserver === 'undefined' || !wrap.value) {
    frameActive.value = true;
  } else {
    visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        frameActive.value = entry?.isIntersecting === true;
      },
      { rootMargin: '1000px 0px' },
    );
    visibilityObserver.observe(wrap.value);
  }
});

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage);
  visibilityObserver?.disconnect();
  visibilityObserver = null;
});

watch(
  () => [props.rawUrl, props.height],
  () => {
    measuredHeight.value = null;
  },
);

useIframeScale(wrap, frame, () => ({
  rw: props.rw,
  ar: props.ar,
  rh: resolvedHeight.value,
  scale: previewScale.value,
}));
</script>

<template>
  <div ref="wrap" class="relative overflow-hidden bg-white" :style="{ aspectRatio: String(frameAspect) }">
    <!-- data-output-frame: claimed by composables/useFrameFocusGuard.ts, which undoes the
         scroll jump a preview causes when its content autofocuses itself on load. -->
    <iframe
      v-if="frameActive"
      ref="frame"
      data-output-frame
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      :src="rawUrl"
      class="absolute left-0 top-0 origin-top-left border-0"
    />
  </div>
</template>

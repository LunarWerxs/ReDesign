import { onMounted, onUnmounted, watch, type Ref } from 'vue';

/**
 * Scale a sandboxed iframe so a logical RW-wide page fits its card, then apply
 * an optional display scale for zoomed-out previews.
 * Sets iframe width=RW, height=RH, transform=scale(wrapWidth/RW * displayScale); the iframe's
 * CSS gives it transform-origin: top left. One ResizeObserver per card, cleaned up
 * on unmount; rescales when width (rw), aspect (ar), height (rh), or display
 * scale changes.
 */
export function useIframeScale(
  wrap: Ref<HTMLElement | null>,
  frame: Ref<HTMLIFrameElement | null>,
  opts: () => { rw: number; ar: number; rh?: number | null; scale?: number },
) {
  let ro: ResizeObserver | null = null;

  const apply = () => {
    const w = wrap.value;
    const f = frame.value;
    const { rw, ar, rh, scale: displayScale = 1 } = opts();
    if (!w || !f || !rw) return;
    const rawHeight = rh && rh > 0 ? rh : rw / ar;
    const scale = (w.clientWidth / rw) * Math.max(0.1, displayScale);
    f.style.width = rw + 'px';
    f.style.height = Math.round(rawHeight) + 'px';
    f.style.left = Math.round((w.clientWidth - rw * scale) / 2) + 'px';
    f.style.transform = `scale(${scale})`;
  };

  onMounted(() => {
    if (!wrap.value) return;
    ro = new ResizeObserver(apply);
    ro.observe(wrap.value);
    apply();
  });

  watch(opts, () => apply());

  onUnmounted(() => {
    ro?.disconnect();
    ro = null;
  });
}

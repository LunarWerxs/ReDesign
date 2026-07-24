import { onMounted, onUnmounted } from 'vue';

/**
 * Stop model-generated previews from scrolling the viewer out from under you.
 *
 * The problem: reimagined pages routinely autofocus something (a search field, the first nav
 * link, a modal's close button). Focusing an element INSIDE a sandboxed iframe focuses the
 * <iframe> element in THIS document, and the browser then scrolls that iframe into view. With a
 * grid of 20 lazily-loading previews, whichever frame won the race yanked the page down to
 * itself — opening a run reliably dumped you a couple of thousand pixels down the gallery for no
 * reason the owner could see. (Confirmed on 2026-07-21: document.activeElement was the 11th
 * preview iframe, sitting exactly at the scroll offset the page had jumped to.)
 *
 * The fix: from the moment a run opens until the owner's first real gesture, a preview iframe is
 * not allowed to hold focus. `focusin` bubbles to the document even when the focused element
 * lives inside the frame, so we see the steal, blur the frame, and put the scroll position back
 * to where the run opened at.
 *
 * Two paths do the same job, because neither alone is trustworthy:
 *   · `focusin` (bubbles to the document even for focus inside the frame) corrects instantly, so
 *     in a normal foreground tab the page never visibly moves.
 *   · a short polling tick backs it up. In a BACKGROUNDED tab the browser still applies the
 *     scroll and still sets document.activeElement, but dispatches neither scroll nor focus
 *     events — measured on 2026-07-21 — so an events-only guard silently does nothing in exactly
 *     the case where a run is opened in a tab that isn't in front yet.
 * The anchor is captured once at arm time rather than sampled from scroll events, so a stolen
 * scroll can never poison the position we're restoring to.
 *
 * The guard ends at the first wheel/key/pointer/touch gesture, so it can never fight the owner's
 * own scrolling, and clicking into a preview to actually use it hands focus over for good.
 * Corrections are capped so a page that re-focuses itself in a loop stops being fought rather
 * than pinning the viewport forever.
 */

/** Marks the preview iframes this guard is responsible for (set in viewer/ScaledFrame.vue). */
const FRAME_SELECTOR = 'iframe[data-output-frame]';
/** How long after a run opens frames are still expected to be loading (and stealing focus). */
const SETTLE_MS = 8000;
/** Backup sweep cadence. Hidden tabs clamp timers to ~1s, which is still soon enough. */
const TICK_MS = 120;
const MAX_CORRECTIONS = 40;

let armed = false;
let anchorY = 0;
let corrections = 0;
let disarmTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let installs = 0;

function disarm() {
  armed = false;
  if (disarmTimer) clearTimeout(disarmTimer);
  if (tickTimer) clearInterval(tickTimer);
  disarmTimer = null;
  tickTimer = null;
}

/** Hand focus back and undo the scroll the steal caused. Returns false once the cap is hit. */
function reclaim(frame: HTMLIFrameElement): void {
  if (corrections >= MAX_CORRECTIONS) {
    disarm();
    return;
  }
  corrections += 1;
  frame.blur();
  if (window.scrollY !== anchorY) window.scrollTo(0, anchorY);
}

function guardedFrame(node: unknown): HTMLIFrameElement | null {
  return node instanceof HTMLIFrameElement && node.matches(FRAME_SELECTOR) ? node : null;
}

function onFocusIn(e: FocusEvent) {
  if (!armed) return;
  const frame = guardedFrame(e.target);
  if (frame) reclaim(frame);
}

function tick() {
  if (!armed) return;
  const frame = guardedFrame(document.activeElement);
  if (frame) reclaim(frame);
  else if (window.scrollY !== anchorY) window.scrollTo(0, anchorY);
}

/** Re-arm the guard, e.g. when a different run's grid is about to render. Safe to call often. */
export function armFrameFocusGuard() {
  armed = true;
  corrections = 0;
  anchorY = window.scrollY;
  if (disarmTimer) clearTimeout(disarmTimer);
  if (tickTimer) clearInterval(tickTimer);
  disarmTimer = setTimeout(disarm, SETTLE_MS);
  tickTimer = setInterval(tick, TICK_MS);
}

const GESTURES = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;

/** Install the listeners for the lifetime of the calling component. */
export function useFrameFocusGuard() {
  onMounted(() => {
    installs += 1;
    if (installs > 1) return;
    document.addEventListener('focusin', onFocusIn, true);
    for (const type of GESTURES) window.addEventListener(type, disarm, { passive: true });
  });
  onUnmounted(() => {
    installs -= 1;
    if (installs > 0) return;
    disarm();
    document.removeEventListener('focusin', onFocusIn, true);
    for (const type of GESTURES) window.removeEventListener(type, disarm);
  });
}

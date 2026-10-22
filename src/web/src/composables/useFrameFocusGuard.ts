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
 *
 * ── Why the guard must never restore the scroll position speculatively ────────────────────────
 * It used to, and that is what made a freshly opened run feel stuck: the page would start to
 * scroll, snap back to the top, and only start behaving after four or five tries. The previews
 * are cross-origin (no `allow-same-origin`, deliberately), and a `wheel` over a cross-origin
 * frame is dispatched in the FRAME's document — it never reaches this one. The preview itself
 * doesn't scroll, so the browser chains the scroll to the page: the viewer moves, but the
 * gesture listener that was supposed to stand the guard down never hears a thing. The next tick
 * then dutifully put the page back at the anchor. Dragging the scrollbar has the same shape (a
 * scrollbar is not a DOM element, so there is no `pointerdown` either). Since a wall of previews
 * means the cursor is almost always over a frame, that was the normal case, not an edge one.
 *
 * So corrections are now tied to EVIDENCE of a steal — a guarded frame actually holding focus,
 * plus a short window afterwards to mop up the scroll it caused — and a scroll this guard cannot
 * attribute to a steal is taken as the owner's and stands the guard down. Between them, a wheel
 * over a preview and a scrollbar drag both end the guard on the first try, and the focus-steal
 * jump the guard exists for is still caught on both paths.
 *
 * The guard also ends at the first wheel/key/pointer/touch gesture, so clicking into a preview to
 * actually use it hands focus over for good. Corrections are capped so a page that re-focuses
 * itself in a loop stops being fought rather than pinning the viewport forever.
 */

/** Marks the preview iframes this guard is responsible for (set in viewer/ScaledFrame.vue). */
const FRAME_SELECTOR = 'iframe[data-output-frame]';
/** How long after a run opens frames are still expected to be loading (and stealing focus). */
const SETTLE_MS = 8000;
/** Backup sweep cadence. Hidden tabs clamp timers to ~1s, which is still soon enough. */
const TICK_MS = 120;
const MAX_CORRECTIONS = 40;
/**
 * How long after an observed steal the scroll it caused may still land. Blurring the frame is
 * synchronous but the browser's scroll-into-view is not always, so a correction gets a brief
 * window to finish; outside it, an unexplained scroll belongs to the owner.
 */
const AFTERSHOCK_MS = 500;
/**
 * Router `scrollBehavior` resets the viewer to the top AFTER the grid mounts, and lazily-mounted
 * frames can nudge the offset as they settle. Scrolls in this opening window re-anchor rather
 * than count as the owner's — but only while no steal has been seen, so a stolen scroll can still
 * never poison the position corrections restore to.
 */
const REANCHOR_MS = 250;

let armed = false;
let anchorY = 0;
let corrections = 0;
let armedAt = 0;
let lastStealAt = 0;
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

/** Undo a scroll a steal caused. Returns false once the cap is hit, having stood the guard down. */
function restoreAnchor(): boolean {
  if (corrections >= MAX_CORRECTIONS) {
    disarm();
    return false;
  }
  corrections += 1;
  if (window.scrollY !== anchorY) window.scrollTo(0, anchorY);
  return true;
}

/** Hand focus back and undo the scroll the steal caused. */
function reclaim(frame: HTMLIFrameElement): void {
  lastStealAt = performance.now();
  if (corrections >= MAX_CORRECTIONS) {
    disarm();
    return;
  }
  frame.blur();
  restoreAnchor();
}

function guardedFrame(node: unknown): HTMLIFrameElement | null {
  return node instanceof HTMLIFrameElement && node.matches(FRAME_SELECTOR) ? node : null;
}

/** True while a correction for a steal we actually saw could still be settling. */
function correctionSettling(): boolean {
  return lastStealAt !== 0 && performance.now() - lastStealAt < AFTERSHOCK_MS;
}

function onFocusIn(e: FocusEvent) {
  if (!armed) return;
  const frame = guardedFrame(e.target);
  if (frame) reclaim(frame);
}

/**
 * A scroll this guard did not cause and cannot pin on a focus steal is the owner scrolling —
 * including the two cases no gesture event reaches us for: a wheel over a cross-origin preview,
 * and a scrollbar drag.
 */
function onScroll() {
  if (!armed) return;
  if (window.scrollY === anchorY) return; // our own correction landing back on the anchor
  if (guardedFrame(document.activeElement)) return; // a steal is in flight; reclaim owns it
  if (correctionSettling()) return; // the scroll a steal we just corrected had already queued
  if (lastStealAt === 0 && performance.now() - armedAt < REANCHOR_MS) {
    anchorY = window.scrollY; // the run is still settling into place; follow it, don't fight it
    return;
  }
  disarm();
}

function tick() {
  if (!armed) return;
  const frame = guardedFrame(document.activeElement);
  if (frame) {
    reclaim(frame);
    return;
  }
  // Only ever in the wake of a steal we observed — see the header note on why a blanket restore
  // here is what made the viewer feel stuck.
  if (!correctionSettling() || window.scrollY === anchorY) return;
  restoreAnchor();
}

/** Re-arm the guard, e.g. when a different run's grid is about to render. Safe to call often. */
export function armFrameFocusGuard() {
  armed = true;
  corrections = 0;
  lastStealAt = 0;
  armedAt = performance.now();
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
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const type of GESTURES) window.addEventListener(type, disarm, { passive: true });
  });
  onUnmounted(() => {
    installs -= 1;
    if (installs > 0) return;
    disarm();
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('scroll', onScroll);
    for (const type of GESTURES) window.removeEventListener(type, disarm);
  });
}

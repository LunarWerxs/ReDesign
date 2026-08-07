import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { armFrameFocusGuard, useFrameFocusGuard } from "@/composables/useFrameFocusGuard";

// The guard blurs preview iframes that steal focus and puts the scroll position back. These
// cover the line it must not cross: it may undo a scroll a STEAL caused, never one the owner
// caused. See the composable's header for why the owner's scroll often arrives with no gesture
// event attached (a wheel over a cross-origin preview, a scrollbar drag).

const Host = defineComponent({
  setup() {
    useFrameFocusGuard();
    return () => h("div");
  },
});

let scrollY = 0;
let clock = 0;

/** Scroll the page the way the browser does: move the offset, then announce it. */
function scrollTo(y: number) {
  scrollY = y;
  window.dispatchEvent(new Event("scroll"));
}

function addFrame() {
  const frame = document.createElement("iframe");
  frame.setAttribute("data-output-frame", "");
  document.body.appendChild(frame);
  return frame;
}

/** happy-dom has no real focus for iframes, so pin activeElement the way the browser would. */
function setActiveElement(node: Element | null) {
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => node });
}

beforeEach(() => {
  vi.useFakeTimers();
  scrollY = 0;
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  vi.spyOn(window, "scrollTo").mockImplementation(((_x: number, y: number) => {
    scrollY = y;
  }) as typeof window.scrollTo);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActiveElement(document.body);
  document.body.innerHTML = "";
});

it("leaves a scroll it cannot pin on a focus steal alone, and stands down", () => {
  const wrapper = mount(Host);
  addFrame();
  armFrameFocusGuard();

  clock = 400; // past the opening window where the run is still settling into place
  scrollTo(600); // the owner's wheel, chained to the page by a cross-origin preview

  vi.advanceTimersByTime(1000); // several backup ticks
  expect(scrollY).toBe(600);

  scrollTo(1200); // and it keeps scrolling, rather than needing four or five tries
  vi.advanceTimersByTime(1000);
  expect(scrollY).toBe(1200);

  wrapper.unmount();
});

it("still blurs a preview that steals focus and puts the scroll back", () => {
  const wrapper = mount(Host);
  const frame = addFrame();
  const blur = vi.spyOn(frame, "blur");
  armFrameFocusGuard();

  clock = 400;
  setActiveElement(frame);
  scrollY = 2400; // the browser scrolled the stolen frame into view
  frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

  expect(blur).toHaveBeenCalled();
  expect(scrollY).toBe(0);

  wrapper.unmount();
});

it("catches a steal with no events at all, the way a backgrounded tab delivers it", () => {
  const wrapper = mount(Host);
  const frame = addFrame();
  armFrameFocusGuard();

  clock = 400;
  setActiveElement(frame); // focus set, page scrolled, neither event dispatched
  scrollY = 2400;

  vi.advanceTimersByTime(200); // the backup tick is the only thing that can see this
  expect(scrollY).toBe(0);

  wrapper.unmount();
});

it("re-anchors to the router's scroll reset instead of fighting it back", () => {
  const wrapper = mount(Host);
  addFrame();
  scrollY = 900; // left over from the page the owner came from
  armFrameFocusGuard();

  clock = 20; // router scrollBehavior lands just after the grid mounts
  scrollTo(0);

  const frame = document.querySelector("iframe") as HTMLIFrameElement;
  clock = 400;
  setActiveElement(frame);
  scrollY = 2400;
  frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

  expect(scrollY).toBe(0); // the top, where the run actually opened — not the stale 900

  wrapper.unmount();
});

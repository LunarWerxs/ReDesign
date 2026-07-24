import { afterEach, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScaledFrame from "@/components/app/viewer/ScaledFrame.vue";

afterEach(() => vi.unstubAllGlobals());

it("keeps far-away preview iframes unmounted and activates them near the viewport", async () => {
  const visibilityCallbacks: IntersectionObserverCallback[] = [];
  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      visibilityCallbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  class FakeResizeObserver {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  const wrapper = mount(ScaledFrame, {
    props: {
      rawUrl: "/output-raw/run/result.html",
      rw: 1280,
      ar: 0.72,
      height: "aspect",
      scale: 1,
    },
  });
  expect(wrapper.find("iframe").exists()).toBe(false);

  visibilityCallbacks[0]!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await nextTick();
  expect(wrapper.find("iframe").attributes("src")).toBe("/output-raw/run/result.html");

  visibilityCallbacks[0]!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  await nextTick();
  expect(wrapper.find("iframe").exists()).toBe(false);

  wrapper.unmount();
});

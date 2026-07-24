import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RunGallery from "@/components/app/viewer/RunGallery.vue";
import { useViewerStore } from "@/stores/viewer";
import type { RunSummary } from "@/types";

/**
 * The gallery serves every thumbnail from ONE endpoint (/api/runs/:id/thumbnail) that owns the
 * whole fallback chain server-side (saved thumb → surviving input → rendered output → 404). The
 * client just shows a spinner until it loads and a placeholder if it 404s. It also hides finished
 * runs that produced nothing (the "0/0 test run" noise the owner asked to discard).
 */

function run(over: Partial<RunSummary>): RunSummary {
  return { runId: "r1", status: "done", counts: { total: 4, ok: 4 }, ...over } as RunSummary;
}

function mountWith(runs: RunSummary[]) {
  const store = useViewerStore();
  store.runs = runs;
  return mount(RunGallery);
}

describe("RunGallery thumbnails", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("points every thumbnail at the backfilling endpoint", () => {
    const wrapper = mountWith([run({ runId: "abc" })]);
    expect(wrapper.get("img").attributes("src")).toBe("/api/runs/abc/thumbnail");
  });

  it("shows a spinner until the thumbnail loads", () => {
    const wrapper = mountWith([run({})]);
    expect(wrapper.find(".animate-spin").exists()).toBe(true);
  });

  it("shows the placeholder when the endpoint 404s (nothing renderable)", async () => {
    const wrapper = mountWith([run({})]);
    await wrapper.get("img").trigger("error");
    // The <img> is gone and the placeholder icon (ImageOff) is shown.
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find(".animate-spin").exists()).toBe(false);
  });

  it("hides the spinner once the image has loaded", async () => {
    const wrapper = mountWith([run({})]);
    await wrapper.get("img").trigger("load");
    expect(wrapper.find(".animate-spin").exists()).toBe(false);
    expect(wrapper.find("img").exists()).toBe(true);
  });

  it("hides finished runs that produced nothing (0/0)", () => {
    const wrapper = mountWith([
      run({ runId: "real", counts: { total: 4, ok: 4 } }),
      run({ runId: "empty-done", status: "done", total: 0, counts: { total: 0, ok: 0 } }),
      run({ runId: "empty-cancelled", status: "cancelled", total: 0, counts: { total: 0, ok: 0 } }),
    ]);
    const imgs = wrapper.findAll("img").map((i) => i.attributes("src"));
    expect(imgs).toEqual(["/api/runs/real/thumbnail"]);
  });

  it("keeps an active (queued) run even at 0/0, since it just hasn't produced yet", () => {
    const wrapper = mountWith([run({ runId: "q", status: "queued", total: 0, counts: { total: 0, ok: 0 } })]);
    expect(wrapper.get("img").attributes("src")).toBe("/api/runs/q/thumbnail");
  });
});

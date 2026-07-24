import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useViewerStore } from "@/stores/viewer";
import type { Job, JobStatus, Manifest, Model, RunEvent, RunStatus } from "@/types";

const { runMock, runsMock, recordFirstStarMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  runsMock: vi.fn(),
  recordFirstStarMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { run: runMock, runs: runsMock },
  eventsUrl: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
}));
vi.mock("@/lib/starTally", () => ({ recordFirstStar: recordFirstStarMock }));

const model = (id: string, label: string): Model => ({
  id,
  label,
  vision: false,
  enabled: true,
  keys: 1,
});

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  inputId: "i1",
  modelId: "m1",
  promptId: "p1",
  variant: 1,
  status: "ok" as JobStatus,
  ...over,
});

const input = (id: string) => ({ id, name: id, type: "image" as const, preview: "p" });

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  runId: "run1",
  status: "done" as RunStatus,
  inputs: [input("i1")],
  prompts: [],
  models: [model("m1", "Model One")],
  jobs: [],
  ...over,
});

beforeEach(() => {
  // starredItems / hiddenItems are now localStorage-backed (they persist across reloads by
  // design), and the test localStorage is a module singleton, so clear it between cases or one
  // test's stars bleed into the next.
  localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isLive", () => {
  it("is false without a manifest", () => {
    expect(useViewerStore().isLive).toBe(false);
  });

  it.each<[RunStatus, boolean]>([
    ["queued", true],
    ["running", true],
    ["done", false],
    ["error", false],
    ["cancelled", false],
  ])("is %s -> %s", (status, expected) => {
    const store = useViewerStore();
    store.manifest = manifest({ status });

    expect(store.isLive).toBe(expected);
  });
});

describe("grouped", () => {
  it("is empty without a manifest", () => {
    expect(useViewerStore().grouped).toEqual([]);
  });

  it("groups jobs under their input and counts the ok ones", () => {
    const store = useViewerStore();
    store.manifest = manifest({
      inputs: [input("i1"), input("i2")],
      jobs: [job("a"), job("b"), job("c", { inputId: "i2" })],
    });

    expect(store.grouped).toHaveLength(2);
    expect(store.grouped[0]!.input.id).toBe("i1");
    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    expect(store.grouped[0]!.okCount).toBe(2);
    expect(store.grouped[1]!.jobs.map((j) => j.id)).toEqual(["c"]);
  });

  it("omits an input whose jobs are all filtered out", () => {
    const store = useViewerStore();
    store.manifest = manifest({
      inputs: [input("i1"), input("i2")],
      jobs: [job("a", { inputId: "i2" })],
    });

    // i1 contributes no visible jobs, so it must not render as an empty row.
    expect(store.grouped.map((g) => g.input.id)).toEqual(["i2"]);
  });

  it("hides jobs whose model is hidden", () => {
    const store = useViewerStore();
    store.manifest = manifest({
      models: [model("m1", "One"), model("m2", "Two")],
      jobs: [job("a"), job("b", { modelId: "m2" })],
    });

    store.toggleModel("m2");

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a"]);
  });

  it("hides jobs whose prompt is hidden", () => {
    const store = useViewerStore();
    store.manifest = manifest({ jobs: [job("a"), job("b", { promptId: "p2" })] });

    store.togglePrompt("p2");

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a"]);
  });

  it("excludes errored jobs until showErrors is on", () => {
    const store = useViewerStore();
    store.manifest = manifest({ jobs: [job("a"), job("b", { status: "error" })] });

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a"]);

    store.showErrors = true;
    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    // An errored job is visible but must not inflate the ok tally.
    expect(store.grouped[0]!.okCount).toBe(1);
  });

  it("never shows a pending job, even with showErrors on", () => {
    const store = useViewerStore();
    store.manifest = manifest({ jobs: [job("a"), job("b", { status: "running" })] });
    store.showErrors = true;

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a"]);
  });

  it("hides an individually hidden item until showHiddenItems is on", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a"), job("b")] });

    store.toggleItemHidden("b");
    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a"]);

    store.showHiddenItems = true;
    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("sorts starred jobs to the front", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a"), job("b"), job("c")] });

    store.toggleItemStarred("c");

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps the original order among equally starred jobs", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a"), job("b"), job("c")] });

    store.toggleItemStarred("b");
    store.toggleItemStarred("c");

    expect(store.grouped[0]!.jobs.map((j) => j.id)).toEqual(["b", "c", "a"]);
  });
});

describe("item keys are scoped to the run", () => {
  it("does not leak a star from one run into another", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a")] });

    store.toggleItemStarred("a");
    expect(store.isItemStarred("a")).toBe(true);

    // Same job id, different run: two runs can legitimately share job ids.
    store.runId = "run2";
    expect(store.isItemStarred("a")).toBe(false);
  });

  it("tracks hidden items per run too", () => {
    const store = useViewerStore();
    store.runId = "run1";

    store.toggleItemHidden("a");
    expect(store.isItemHidden("a")).toBe(true);

    store.runId = "run2";
    expect(store.isItemHidden("a")).toBe(false);
  });

  it("toggles a star off again", () => {
    const store = useViewerStore();
    store.runId = "run1";

    store.toggleItemStarred("a");
    store.toggleItemStarred("a");

    expect(store.isItemStarred("a")).toBe(false);
  });
});

describe("toggleItemStarred / first star tally", () => {
  it("records the first star of a run against the model's label", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({
      models: [model("m1", "Model One")],
      jobs: [job("a")],
    });

    store.toggleItemStarred("a");

    expect(recordFirstStarMock).toHaveBeenCalledExactlyOnceWith("run1", "Model One");
  });

  it("records only the first star, not later ones in the same run", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({
      models: [model("m1", "One"), model("m2", "Two")],
      jobs: [job("a"), job("b", { modelId: "m2" })],
    });

    store.toggleItemStarred("a");
    store.toggleItemStarred("b");

    expect(recordFirstStarMock).toHaveBeenCalledTimes(1);
    expect(recordFirstStarMock).toHaveBeenCalledWith("run1", "One");
  });

  it("does not record when un-starring", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a")] });

    store.toggleItemStarred("a");
    recordFirstStarMock.mockClear();
    store.toggleItemStarred("a");

    expect(recordFirstStarMock).not.toHaveBeenCalled();
  });

  it("counts as first again once the earlier star is removed", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ jobs: [job("a"), job("b")] });

    store.toggleItemStarred("a");
    store.toggleItemStarred("a"); // back to zero stars in this run
    recordFirstStarMock.mockClear();
    store.toggleItemStarred("b");

    expect(recordFirstStarMock).toHaveBeenCalledExactlyOnceWith("run1", "Model One");
  });

  it("falls back to the model id when it has no label", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ models: [model("m1", "")], jobs: [job("a")] });

    store.toggleItemStarred("a");

    expect(recordFirstStarMock).toHaveBeenCalledWith("run1", "m1");
  });

  it("skips the tally when the job's model is unknown", () => {
    const store = useViewerStore();
    store.runId = "run1";
    store.manifest = manifest({ models: [], jobs: [job("a")] });

    store.toggleItemStarred("a");

    expect(recordFirstStarMock).not.toHaveBeenCalled();
    // The star itself still lands; only the cross-run tally is skipped.
    expect(store.isItemStarred("a")).toBe(true);
  });

  it("skips the tally when no run is loaded", () => {
    const store = useViewerStore();
    store.runId = null;
    store.manifest = manifest({ jobs: [job("a")] });

    store.toggleItemStarred("a");

    expect(recordFirstStarMock).not.toHaveBeenCalled();
  });
});

describe("load", () => {
  it("clears the manifest for a null id", async () => {
    const store = useViewerStore();
    store.manifest = manifest();

    await store.load(null);

    expect(store.manifest).toBeNull();
    expect(store.runId).toBeNull();
    expect(runMock).not.toHaveBeenCalled();
  });

  it("stores the fetched manifest", async () => {
    const m = manifest({ jobs: [job("a")] });
    runMock.mockResolvedValue(m);
    const store = useViewerStore();

    await store.load("run1");

    expect(runMock).toHaveBeenCalledWith("run1");
    expect(store.manifest).toEqual(m);
  });

  it("nulls the manifest when the fetch fails", async () => {
    runMock.mockRejectedValue(new Error("offline"));
    const store = useViewerStore();
    store.manifest = manifest();

    await store.load("run1");

    expect(store.manifest).toBeNull();
  });
});

describe("loadRuns", () => {
  it("stores the fetched runs", async () => {
    runsMock.mockResolvedValue([{ runId: "run1", status: "done" as RunStatus }]);
    const store = useViewerStore();

    await store.loadRuns();

    expect(store.runs).toHaveLength(1);
  });

  it("degrades to an empty list when the fetch fails", async () => {
    runsMock.mockRejectedValue(new Error("offline"));
    const store = useViewerStore();

    await store.loadRuns();

    expect(store.runs).toEqual([]);
  });
});

describe("reconcileItemState on load", () => {
  it("prunes stale keys belonging to the loaded run", async () => {
    runMock.mockResolvedValue(manifest({ runId: "run1", jobs: [job("fresh")] }));
    const store = useViewerStore();
    store.starredItems = ["run1:gone", "run1:fresh"];
    store.hiddenItems = ["run1:gone"];

    await store.load("run1");

    expect(store.starredItems).toEqual(["run1:fresh"]);
    expect(store.hiddenItems).toEqual([]);
  });

  it("leaves other runs' keys untouched", async () => {
    // The prune is deliberately scoped to the loaded run: keys for runs we have not
    // fetched carry no job list to validate against, so dropping them would lose stars.
    runMock.mockResolvedValue(manifest({ runId: "run1", jobs: [job("fresh")] }));
    const store = useViewerStore();
    store.starredItems = ["run2:keep", "run1:gone"];

    await store.load("run1");

    expect(store.starredItems).toEqual(["run2:keep"]);
  });
});

describe("polling", () => {
  it("polls a live run and stops once it finishes", async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue(manifest({ status: "running" }));
    const store = useViewerStore();

    await store.load("run1");
    expect(runMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2500);
    expect(runMock).toHaveBeenCalledTimes(2);

    // The run finishes; the next poll should be the last.
    runMock.mockResolvedValue(manifest({ status: "done" }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(runMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  it("does not poll a run that is already finished", async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue(manifest({ status: "done" }));
    const store = useViewerStore();

    await store.load("run1");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient fetch error", async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue(manifest({ status: "running" }));
    const store = useViewerStore();
    await store.load("run1");

    const live = store.manifest;
    runMock.mockRejectedValueOnce(new Error("blip"));
    await vi.advanceTimersByTimeAsync(2500);

    // A blip must not blank the view or kill the timer.
    expect(store.manifest).toEqual(live);
    await vi.advanceTimersByTimeAsync(2500);
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  it("stops the previous poll when another run is loaded", async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue(manifest({ status: "running" }));
    const store = useViewerStore();

    await store.load("run1");
    await store.load("run2");
    runMock.mockClear();

    await vi.advanceTimersByTimeAsync(2500);

    // Exactly one timer should survive, not one per load.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith("run2");
  });

  it("stopPoll halts further polling", async () => {
    vi.useFakeTimers();
    runMock.mockResolvedValue(manifest({ status: "running" }));
    const store = useViewerStore();
    await store.load("run1");

    store.stopPoll();
    runMock.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("live SSE", () => {
  it("uses the run event stream when available and closes it on completion", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      close() {
        this.closed = true;
      }
      emit(event: RunEvent) {
        this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    runMock.mockResolvedValue(
      manifest({ status: "running", jobs: [job("existing", { status: "running" })] }),
    );
    const store = useViewerStore();

    await store.load("run1");

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/runs/run1/events");
    const initialJobs = store.manifest!.jobs;
    source.emit({ type: "job", runId: "run1", job: job("existing") });
    expect(store.manifest?.jobs).toBe(initialJobs);
    expect(store.manifest?.jobs).toHaveLength(1);
    expect(store.manifest?.jobs[0]?.status).toBe("ok");

    source.emit({ type: "job", runId: "run1", job: job("fresh") });
    expect(store.manifest?.jobs.map((j) => j.id)).toEqual(["existing", "fresh"]);

    const done = manifest({ status: "done", jobs: [job("existing"), job("fresh")] });
    source.emit({ type: "done", runId: "run1", manifest: done });
    expect(store.manifest).toEqual(done);
    expect(source.closed).toBe(true);
  });
});

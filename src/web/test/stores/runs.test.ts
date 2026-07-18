// Behavioral coverage for the run-queue actions (stores/control/runs.ts): queueing a
// second run behind a live one, re-attaching after a reload, focus handoff as runs
// finish, and the rule that a still-generating run is never torn down client-side.
//
// The module talks to three things — the HTTP api, an SSE EventSource, and toasts —
// so all three are faked here. `feed()` pushes a server event into a run's fake
// stream exactly the way the real broadcast would.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick } from "vue";
import type { Manifest, RunSummary } from "@/types";

const apiMock = {
  runs: vi.fn(async (): Promise<RunSummary[]> => []),
  run: vi.fn(async (_id: string): Promise<Manifest> => manifest("unknown", "done")),
  startRun: vi.fn(async () => ({ runId: "new-run" })),
  cancelRun: vi.fn(async () => ({ ok: true })),
  deleteRuns: vi.fn(async () => ({ deleted: [] as string[], skipped: [], runs: [] as RunSummary[] })),
  estimateRunCost: vi.fn(async () => null),
};

vi.mock("@/lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  eventsUrl: (id: string) => `/api/runs/${id}/events`,
}));

vi.mock("vue-sonner", () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast };
});

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

// ── Fake EventSource ──────────────────────────────────────────────────────────
class FakeEventSource {
  static open = new Map<string, FakeEventSource>();
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.open.set(url, this);
  }
  close() {
    this.closed = true;
    FakeEventSource.open.delete(this.url);
  }
}
vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);

/** Push a server event into a run's stream, the way runQueue.broadcast() would. */
function feed(runId: string, event: unknown) {
  const es = FakeEventSource.open.get(`/api/runs/${runId}/events`);
  if (!es) throw new Error(`no open stream for ${runId}`);
  es.onmessage?.({ data: JSON.stringify(event) });
}
const streaming = (runId: string) => FakeEventSource.open.has(`/api/runs/${runId}/events`);

function manifest(runId: string, status: string, over: Partial<Manifest> = {}): Manifest {
  return {
    runId,
    status: status as Manifest["status"],
    counts: { total: 4, done: 0, ok: 0, error: 0, skipped: 0 },
    inputs: [],
    prompts: [],
    models: [],
    jobs: [],
    ...over,
  } as Manifest;
}

const summary = (runId: string, status: string): RunSummary =>
  ({ runId, status, counts: { total: 4 } }) as RunSummary;

// Imported after the mocks are registered.
const { createControlState } = await import("@/stores/control/state");
const { createRunsActions } = await import("@/stores/control/runs");

function harness() {
  const state = createControlState();
  const actions = createRunsActions(state, { refreshKeys: vi.fn(async () => {}) });
  return { state, actions };
}

/** A selection valid enough for startRun() to get past its guards. */
function ready(state: ReturnType<typeof createControlState>) {
  state.selInputs.value = ["i1"];
  state.selModels.value = ["m1"];
  state.selPrompts.value = ["p1"];
}

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.open.clear();
  vi.clearAllMocks();
  apiMock.runs.mockResolvedValue([]);
  apiMock.startRun.mockResolvedValue({ runId: "new-run" });
});

describe("startRun", () => {
  it("queues a second run behind the live one instead of replacing it", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });

    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.startRun();

    expect(state.trackedRuns.has("run1")).toBe(true);
    expect(state.trackedRuns.has("run2")).toBe(true);
    expect(streaming("run1")).toBe(true);
    expect(streaming("run2")).toBe(true);
    // the card stays on what is actually generating
    expect(state.focusedRunId.value).toBe("run1");
    expect(state.backlogRuns.value.map((r) => r.runId)).toEqual(["run2"]);
  });

  it("focuses the first run when nothing is active", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "solo" });
    await actions.startRun();

    expect(state.focusedRunId.value).toBe("solo");
    expect(state.running.value).toBe(true);
  });

  it("refuses to submit without an input, a model and a prompt", async () => {
    const { state, actions } = harness();
    await actions.startRun();
    expect(apiMock.startRun).not.toHaveBeenCalled();
    expect(state.trackedRuns.size).toBe(0);
  });
});

describe("streamed progress", () => {
  it("routes job events to the run they belong to, not the focused one", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });
    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.startRun();

    feed("run2", { type: "job", runId: "run2", job: { id: "j1", status: "ok" } });

    expect(state.trackedRuns.get("run2")?.jobs.size).toBe(1);
    expect(state.trackedRuns.get("run1")?.jobs.size).toBe(0);
    expect(state.jobList.value).toEqual([]); // focused run is still run1
  });

  it("hands the card to the queued run when the live one finishes", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });
    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.startRun();
    feed("run2", { type: "snapshot", runId: "run2", manifest: manifest("run2", "queued", { queue: { position: 1 } }) });

    feed("run1", { type: "done", runId: "run1", manifest: manifest("run1", "done") });

    expect(state.focusedRunId.value).toBe("run2");
    expect(streaming("run1")).toBe(false); // finished stream is closed, not left reconnecting
    expect(streaming("run2")).toBe(true);
  });

  it("closes the stream of a run that errors", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();

    feed("run1", { type: "error", runId: "run1", message: "boom" });

    expect(streaming("run1")).toBe(false);
    expect(state.trackedRuns.get("run1")?.status).toBe("error");
    expect(state.anyRunActive.value).toBe(false);
  });
});

describe("resumeRuns", () => {
  it("re-attaches to everything the server is still working on after a reload", async () => {
    const { state, actions } = harness();
    state.runs.value = [summary("run2", "queued"), summary("run1", "running")];

    await actions.resumeRuns();

    expect(streaming("run1")).toBe(true);
    expect(streaming("run2")).toBe(true);
    expect(state.focusedRunId.value).toBe("run1"); // the one actually generating
    expect(state.backlogRuns.value.map((r) => r.runId)).toEqual(["run2"]);
  });

  it("restores the run the tab was watching when it finished while away", async () => {
    const { state, actions } = harness();
    state.focusedRunId.value = "old";
    state.runs.value = [summary("old", "done")];
    apiMock.run.mockResolvedValueOnce(
      manifest("old", "done", { counts: { total: 2, done: 2, ok: 2, error: 0, skipped: 0 }, jobs: [{ id: "j1", status: "ok" }] as Manifest["jobs"] }),
    );

    await actions.resumeRuns();

    expect(state.runId.value).toBe("old");
    expect(state.progress.value).toMatchObject({ done: 1, total: 2 });
    expect(streaming("old")).toBe(false); // finished: restored read-only, no stream
  });

  it("attaches anyway when the fresher single-run read says it is still going", async () => {
    const { state, actions } = harness();
    state.focusedRunId.value = "old";
    state.runs.value = [summary("old", "done")]; // the disk list lagged
    apiMock.run.mockResolvedValueOnce(manifest("old", "running"));

    await actions.resumeRuns();

    expect(streaming("old")).toBe(true);
  });

  it("forgets a remembered run that has since been deleted", async () => {
    const { state, actions } = harness();
    state.focusedRunId.value = "gone";
    state.runs.value = [summary("other", "done")];

    await actions.resumeRuns();

    expect(state.focusedRunId.value).toBeNull();
    expect(apiMock.run).not.toHaveBeenCalled();
  });

  it("does not let a second bootstrap overwrite a run it is already streaming", async () => {
    const { state, actions } = harness();
    state.runs.value = [summary("run1", "running")];
    await actions.resumeRuns();
    feed("run1", {
      type: "snapshot",
      runId: "run1",
      manifest: manifest("run1", "running", { counts: { total: 99, done: 0, ok: 0, error: 0, skipped: 0 } }),
    });

    // Control.vue remounts -> bootstrap runs again with a staler disk summary
    await actions.resumeRuns();

    expect(state.trackedRuns.get("run1")?.total).toBe(99);
    expect(FakeEventSource.open.size).toBe(1); // no duplicate stream
  });
});

describe("deleteRuns", () => {
  it("never tears down a run that is still generating", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });

    // The flyout lets any row be selected; the server refuses an active delete, so
    // the client must not pre-emptively drop the stream either.
    await actions.deleteRuns(["run1"]);

    expect(streaming("run1")).toBe(true);
    expect(state.trackedRuns.has("run1")).toBe(true);
    expect(state.focusedRunId.value).toBe("run1");
  });

  it("drops the card of a finished run being deleted", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();
    feed("run1", { type: "done", runId: "run1", manifest: manifest("run1", "done") });
    await nextTick();

    await actions.deleteRuns(["run1"]);

    expect(state.trackedRuns.has("run1")).toBe(false);
    expect(state.runId.value).toBeNull();
  });
});

describe("cancelRun", () => {
  it("cancels the focused run by default and a named one on request", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.startRun();

    await actions.cancelRun();
    expect(apiMock.cancelRun).toHaveBeenLastCalledWith("run1");

    await actions.cancelRun("run2");
    expect(apiMock.cancelRun).toHaveBeenLastCalledWith("run2");

    state.focusedRunId.value = null;
    apiMock.cancelRun.mockClear();
    await actions.cancelRun();
    expect(apiMock.cancelRun).not.toHaveBeenCalled();
  });
});

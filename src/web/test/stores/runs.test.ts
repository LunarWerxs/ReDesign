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
  startQueue: vi.fn(async () => ({ started: 1, held: 0 })),
  reorderQueue: vi.fn(async (order: string[]) => ({ order })),
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

const summary = (runId: string, status: string, over: Partial<RunSummary> = {}): RunSummary =>
  ({ runId, status, counts: { total: 4 }, ...over }) as RunSummary;

// Imported after the mocks are registered.
const { createControlState } = await import("@/stores/control/state");
const { createRunsActions } = await import("@/stores/control/runs");

function harness() {
  const state = createControlState();
  const actions = createRunsActions(state, { refreshKeys: vi.fn(async () => {}) });
  return { state, actions };
}

/** A selection valid enough for addToQueue() to get past its guards. */
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
  apiMock.startQueue.mockResolvedValue({ started: 1, held: 0 });
});

describe("addToQueue", () => {
  it("queues a second run behind the live one instead of replacing it", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });

    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.addToQueue();

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
    await actions.addToQueue();

    expect(state.focusedRunId.value).toBe("solo");
    expect(state.running.value).toBe(true);
  });

  it("refuses to submit without an input, a model and a prompt", async () => {
    const { state, actions } = harness();
    await actions.addToQueue();
    expect(apiMock.startRun).not.toHaveBeenCalled();
    expect(state.trackedRuns.size).toBe(0);
  });

  // The whole point of the split: submitting must not spend a key. If this ever
  // regresses, "Add to queue" silently becomes "Run" again and a mis-click can
  // launch a 900-job fan-out.
  it("parks the run instead of starting it", async () => {
    const { state, actions } = harness();
    ready(state);
    await actions.addToQueue();

    expect(apiMock.startRun).toHaveBeenCalledWith(expect.objectContaining({ autoStart: false }));
    expect(apiMock.startQueue).not.toHaveBeenCalled();
    expect(state.heldRuns.value.map((r) => r.runId)).toEqual(["new-run"]);
  });
});

describe("runQueue", () => {
  it("releases the parked runs and focuses the one about to generate", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.addToQueue();
    expect(state.heldRuns.value).toHaveLength(2);

    apiMock.startQueue.mockResolvedValueOnce({ started: 2, held: 0 });
    await actions.runQueue();

    expect(apiMock.startQueue).toHaveBeenCalledTimes(1);
    expect(state.focusedRunId.value).toBe("run1");
  });

  it("does nothing when the queue is empty, so the press can't fire on stale state", async () => {
    const { actions } = harness();
    await actions.runQueue();
    expect(apiMock.startQueue).not.toHaveBeenCalled();
  });
});

describe("reorderQueue (drag-to-reorder)", () => {
  it("optimistically renumbers positions and tells the server the new order", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "q1" });
    await actions.addToQueue();
    apiMock.startRun.mockResolvedValueOnce({ runId: "q2" });
    await actions.addToQueue();
    apiMock.startRun.mockResolvedValueOnce({ runId: "q3" });
    await actions.addToQueue();

    await actions.reorderQueue(["q3", "q1", "q2"]);

    expect(apiMock.reorderQueue).toHaveBeenCalledWith(["q3", "q1", "q2"]);
    // Positions applied immediately so activeRuns (sorted by position) reflects the drag.
    expect(state.trackedRuns.get("q3")?.queuePosition).toBe(1);
    expect(state.trackedRuns.get("q1")?.queuePosition).toBe(2);
    expect(state.trackedRuns.get("q2")?.queuePosition).toBe(3);
    expect(state.heldRuns.value.map((r) => r.runId)).toEqual(["q3", "q1", "q2"]);
  });

  it("re-reads from the server if the reorder request fails", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "q1" });
    await actions.addToQueue();
    apiMock.reorderQueue.mockRejectedValueOnce(new Error("nope"));
    apiMock.runs.mockResolvedValueOnce([]);

    await actions.reorderQueue(["q1"]);

    expect(apiMock.runs).toHaveBeenCalled();
  });
});

describe("runNow (the split Run button)", () => {
  // The primary "Run" press must be one obvious action: park the current batch AND release it,
  // so the user never has to discover a separate "Run queue" step.
  it("submits the current batch and immediately releases the queue", async () => {
    const { state, actions } = harness();
    ready(state);
    await actions.runNow();

    expect(apiMock.startRun).toHaveBeenCalledWith(expect.objectContaining({ autoStart: false }));
    expect(apiMock.startQueue).toHaveBeenCalledTimes(1);
  });

  // An incomplete selection must not release a previously-parked queue on this press —
  // addToQueue's toast has already explained what's missing.
  it("does not start anything when the selection is incomplete and nothing was parked", async () => {
    const { actions } = harness();
    await actions.runNow();
    expect(apiMock.startRun).not.toHaveBeenCalled();
    expect(apiMock.startQueue).not.toHaveBeenCalled();
  });

  // Defect fix: "Run" with parked batches but an EMPTY current selection (the common case —
  // inputs aren't remembered across sessions) must run the parked queue WITHOUT re-submitting
  // the empty selection or nagging "pick an input".
  it("runs the parked queue without re-submitting when the current selection is empty", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "parked1" });
    await actions.addToQueue(); // park one
    // Now clear the working selection, as a fresh session would have it.
    state.selInputs.value = [];
    apiMock.startRun.mockClear();

    await actions.runNow();

    expect(apiMock.startRun).not.toHaveBeenCalled(); // no extra batch submitted
    expect(apiMock.startQueue).toHaveBeenCalledTimes(1); // the parked one runs
  });
});

describe("addToQueue(autoStart)", () => {
  // "Add to queue" while a queue is already running tacks the batch onto the LIVE queue, so it
  // must not be parked (held) — a held run would never start without a further press.
  it("submits an auto-starting run that is not held", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "live1" });
    await actions.addToQueue(true);

    expect(apiMock.startRun).toHaveBeenCalledWith(expect.objectContaining({ autoStart: true }));
    expect(state.heldRuns.value).toHaveLength(0);
  });

  // A queued run stops being "held" the moment the server says it is running, so the
  // button greys out instead of offering to start something already generating.
  it("drops a run out of heldRuns once the server reports it running", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    expect(state.heldRuns.value).toHaveLength(1);

    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });

    expect(state.heldRuns.value).toHaveLength(0);
    expect(state.anyRunActive.value).toBe(true);
  });

  // A run submitted by the MCP tools or the CLI carries no `held` flag: it starts on
  // its own, so "Run queue" must not claim to be waiting on it.
  it("ignores runs that were never held", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    feed("run1", {
      type: "snapshot",
      runId: "run1",
      manifest: manifest("run1", "queued", { queue: { position: 1 } }),
    });

    expect(state.heldRuns.value).toHaveLength(0);
  });
});

describe("streamed progress", () => {
  it("routes job events to the run they belong to, not the focused one", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });
    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.addToQueue();

    feed("run2", { type: "job", runId: "run2", job: { id: "j1", status: "ok" } });

    expect(state.trackedRuns.get("run2")?.jobs.size).toBe(1);
    expect(state.trackedRuns.get("run1")?.jobs.size).toBe(0);
    expect(state.jobList.value).toEqual([]); // focused run is still run1
  });

  it("hands the card to the queued run when the live one finishes", async () => {
    const { state, actions } = harness();
    ready(state);
    apiMock.startRun.mockResolvedValueOnce({ runId: "run1" });
    await actions.addToQueue();
    feed("run1", { type: "start", runId: "run1", manifest: manifest("run1", "running") });
    apiMock.startRun.mockResolvedValueOnce({ runId: "run2" });
    await actions.addToQueue();
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
    await actions.addToQueue();

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

  // Regression: a reload with a PARKED (held) queue and nothing running must resume as held —
  // otherwise queueRunning briefly reads true and the run button mis-draws its "queue is live"
  // shape (no "Run queue (N)") until the first SSE snapshot lands.
  it("resumes a parked run as held, so the queue reads as parked not live", async () => {
    const { state, actions } = harness();
    state.runs.value = [summary("parked", "queued", { queueHeld: true, queuePosition: 1 })];

    await actions.resumeRuns();

    expect(state.heldRuns.value.map((r) => r.runId)).toEqual(["parked"]);
    expect(state.queueRunning.value).toBe(false);
  });

  it("resumes a released-but-not-started run as live (not held)", async () => {
    const { state, actions } = harness();
    state.runs.value = [summary("released", "queued", { queueHeld: false, queuePosition: 1 })];

    await actions.resumeRuns();

    expect(state.heldRuns.value).toHaveLength(0);
    expect(state.queueRunning.value).toBe(true);
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
    await actions.addToQueue();
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
    await actions.addToQueue();
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
    await actions.addToQueue();

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

import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { createControlState, isRunnable, errMessage, isActiveStatus } from "@/stores/control/state";
import { ApiError } from "@/lib/httpClient";
import type { Job, JobStatus, Model } from "@/types";

type ControlState = ReturnType<typeof createControlState>;

/** Track a run and point the progress getters at it, the way runs.ts does on submit. */
const focusRun = (s: ControlState, id = "run1", total = 0) => {
  const entry = s.trackRun(id, { total, status: "running" });
  s.focusedRunId.value = id;
  return entry;
};

const model = (over: Partial<Model> = {}): Model => ({
  id: "m1",
  label: "Model One",
  vision: false,
  enabled: true,
  keys: 1,
  ...over,
});

const job = (id: string, status: JobStatus): Job => ({
  id,
  inputId: "i1",
  modelId: "m1",
  promptId: "p1",
  variant: 1,
  status,
});

beforeEach(() => {
  localStorage.clear();
});

describe("isRunnable", () => {
  it("needs both an enabled flag and at least one key", () => {
    expect(isRunnable(model({ enabled: true, keys: 1 }))).toBe(true);
    expect(isRunnable(model({ enabled: true, keys: 0 }))).toBe(false);
    expect(isRunnable(model({ enabled: false, keys: 5 }))).toBe(false);
    expect(isRunnable(model({ enabled: false, keys: 0 }))).toBe(false);
  });
});

describe("errMessage", () => {
  it("unwraps an ApiError to its message", () => {
    expect(errMessage(new ApiError(404, "gone"))).toBe("gone");
  });

  it("unwraps a plain Error to its message", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error throw", () => {
    // Toast descriptions must never render "[object Object]"-by-accident for a bare string throw.
    expect(errMessage("just a string")).toBe("just a string");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(42)).toBe("42");
  });
});

describe("createControlState getters", () => {
  it("counts only runnable models", () => {
    const s = createControlState();
    s.models.value = [
      model({ id: "a", enabled: true, keys: 2 }),
      model({ id: "b", enabled: true, keys: 0 }),
      model({ id: "c", enabled: false, keys: 3 }),
    ];

    expect(s.runnableModelIds.value).toEqual(["a"]);
    expect(s.runnableModels.value).toHaveLength(1);
  });

  it("summarises the environment as models and inputs", () => {
    const s = createControlState();
    s.models.value = [model({ id: "a" }), model({ id: "b" })];
    s.inputs.value = [{ id: "i1", name: "one", type: "image", preview: "p" }];

    expect(s.envNote.value).toBe("2 models · 1 inputs");
  });
});

describe("estimate", () => {
  it("prompts for a selection when nothing is chosen", () => {
    const s = createControlState();

    expect(s.estimate.value.count).toBe(0);
    expect(s.estimate.value.text).toBe("select inputs, models & a prompt");
  });

  it("multiplies inputs by model runs by prompts", () => {
    const s = createControlState();
    s.selInputs.value = ["i1", "i2"];
    s.selModels.value = ["m1", "m2"];
    s.selPrompts.value = ["p1"];

    expect(s.estimate.value.count).toBe(4);
  });

  it("singularises the label for exactly one job", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];

    expect(s.estimate.value.text).toBe("1 job (1 inputs × 1 model runs × 1 prompts)");
  });

  it("pluralises the label past one job", () => {
    const s = createControlState();
    s.selInputs.value = ["i1", "i2"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];

    expect(s.estimate.value.text).toBe("2 jobs (2 inputs × 1 model runs × 1 prompts)");
  });

  it("weights each model by its per-model quantity", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1", "m2"];
    s.selPrompts.value = ["p1"];
    s.modelQty.value = { m1: 3 }; // m2 is absent, so it defaults to 1

    expect(s.estimate.value.count).toBe(4);
    expect(s.estimate.value.text).toBe("4 jobs (1 inputs × 4 model runs × 1 prompts)");
  });

  it("floors a bogus quantity at one rather than zeroing the run out", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];
    s.modelQty.value = { m1: 0 };

    expect(s.estimate.value.count).toBe(1);

    s.modelQty.value = { m1: -5 };
    expect(s.estimate.value.count).toBe(1);
  });

  it("counts a non-blank custom prompt as one more prompt", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];
    s.customOn.value = true;
    s.custom.value = "make it pop";

    expect(s.estimate.value.count).toBe(2);
  });

  it("ignores a custom prompt that is enabled but blank", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];
    s.customOn.value = true;
    s.custom.value = "   ";

    expect(s.estimate.value.count).toBe(1);
  });

  it("ignores custom text while the custom toggle is off", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.selPrompts.value = ["p1"];
    s.customOn.value = false;
    s.custom.value = "make it pop";

    expect(s.estimate.value.count).toBe(1);
  });

  it("shows a custom-only run as one prompt in the label", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.selModels.value = ["m1"];
    s.customOn.value = true;
    s.custom.value = "make it pop";

    expect(s.estimate.value.count).toBe(1);
    expect(s.estimate.value.text).toBe("1 job (1 inputs × 1 model runs × 1 prompts)");
  });
});

describe("progress", () => {
  it("is all zeroes with no jobs", () => {
    const s = createControlState();

    expect(s.progress.value).toEqual({ done: 0, ok: 0, error: 0, skipped: 0, total: 0, pct: 0 });
  });

  it("counts terminal jobs as done and leaves running ones out", () => {
    const s = createControlState();
    const run = focusRun(s, "run1", 4);
    run.jobs.set("a", job("a", "ok"));
    run.jobs.set("b", job("b", "error"));
    run.jobs.set("c", job("c", "skipped"));
    run.jobs.set("d", job("d", "running"));

    expect(s.progress.value).toEqual({ done: 3, ok: 1, error: 1, skipped: 1, total: 4, pct: 75 });
  });

  it("folds cancelled in with skipped", () => {
    const s = createControlState();
    focusRun(s, "run1", 1).jobs.set("a", job("a", "cancelled"));

    expect(s.progress.value).toMatchObject({ done: 1, skipped: 1, ok: 0, error: 0, pct: 100 });
  });

  it("treats pending and queued as not started", () => {
    const s = createControlState();
    const run = focusRun(s, "run1", 2);
    run.jobs.set("a", job("a", "pending"));
    run.jobs.set("b", job("b", "queued"));

    expect(s.progress.value).toMatchObject({ done: 0, pct: 0, total: 2 });
  });

  it("prefers the declared total over the job count, so a partial stream reads honestly", () => {
    const s = createControlState();
    // the run declares 10 jobs; only one has streamed in so far
    focusRun(s, "run1", 10).jobs.set("a", job("a", "ok"));

    expect(s.progress.value).toMatchObject({ done: 1, total: 10, pct: 10 });
  });

  it("falls back to the job count when no total is declared", () => {
    const s = createControlState();
    const run = focusRun(s);
    run.jobs.set("a", job("a", "ok"));
    run.jobs.set("b", job("b", "running"));

    expect(s.progress.value).toMatchObject({ done: 1, total: 2, pct: 50 });
  });

  it("rounds the percentage", () => {
    const s = createControlState();
    const run = focusRun(s);
    run.jobs.set("a", job("a", "ok"));
    run.jobs.set("b", job("b", "running"));
    run.jobs.set("c", job("c", "running"));

    expect(s.progress.value.pct).toBe(33);
  });

  it("reads only the focused run, so a queued run's jobs never leak into the card", () => {
    const s = createControlState();
    const first = focusRun(s, "run1", 2);
    first.jobs.set("a", job("a", "ok"));
    const second = s.trackRun("run2", { total: 5 });
    second.jobs.set("b", job("b", "ok"));
    second.jobs.set("c", job("c", "ok"));

    expect(s.progress.value).toMatchObject({ done: 1, total: 2 });
    s.focusedRunId.value = "run2";
    expect(s.progress.value).toMatchObject({ done: 2, total: 5 });
  });
});

describe("run queue", () => {
  it("calls only queued and running runs active", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("done")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
    expect(isActiveStatus(null)).toBe(false);
  });

  it("keeps runs in submit order and lists the backlog behind the focused one", () => {
    const s = createControlState();
    focusRun(s, "run1");
    s.trackRun("run2", { status: "queued", queuePosition: 1 });
    s.trackRun("run3", { status: "queued", queuePosition: 2 });

    expect(s.activeRuns.value.map((r) => r.runId)).toEqual(["run1", "run2", "run3"]);
    expect(s.backlogRuns.value.map((r) => r.runId)).toEqual(["run2", "run3"]);
    expect(s.anyRunActive.value).toBe(true);
  });

  it("orders by the server's queue position, not the order we happened to learn of them", () => {
    const s = createControlState();
    // /api/runs answers newest-first, so a resume tracks the tail of the queue first
    s.trackRun("run3", { status: "queued", queuePosition: 2 });
    s.trackRun("run2", { status: "queued", queuePosition: 1 });
    s.trackRun("run1", { status: "running" });

    expect(s.activeRuns.value.map((r) => r.runId)).toEqual(["run1", "run2", "run3"]);
  });

  it("sorts a just-submitted run to the back until the server tells us its position", () => {
    const s = createControlState();
    focusRun(s, "run1");
    s.trackRun("run2", { status: "queued", queuePosition: 1 });
    s.trackRun("run3", { status: "queued" }); // POST returned, no snapshot yet

    expect(s.activeRuns.value.map((r) => r.runId)).toEqual(["run1", "run2", "run3"]);
  });

  it("drops a finished run out of the backlog but keeps it viewable", () => {
    const s = createControlState();
    focusRun(s, "run1");
    const queued = s.trackRun("run2", { status: "queued" });
    queued.status = "done";

    expect(s.backlogRuns.value).toEqual([]);
    expect(s.trackedRuns.has("run2")).toBe(true);
  });

  it("re-tracking a live run keeps its streamed jobs and its place in line", () => {
    const s = createControlState();
    const run = focusRun(s, "run1");
    run.jobs.set("a", job("a", "ok"));
    s.trackRun("run2", { status: "queued" });

    s.trackRun("run1", { status: "running", total: 9 });

    expect(s.trackedRuns.get("run1")?.jobs.size).toBe(1);
    expect(s.trackedRuns.get("run1")?.total).toBe(9);
    expect(s.activeRuns.value.map((r) => r.runId)).toEqual(["run1", "run2"]);
  });

  it("untracking the focused run clears the card", () => {
    const s = createControlState();
    focusRun(s, "run1");

    s.untrackRun("run1");

    expect(s.runId.value).toBeNull();
    expect(s.running.value).toBe(false);
    expect(s.focusedRunId.value).toBeNull();
  });

  it("surfaces the focused run's title, status and queue position", () => {
    const s = createControlState();
    s.trackRun("run1", { title: "dark editorial", status: "queued", queuePosition: 3, total: 6 });
    s.focusedRunId.value = "run1";

    expect(s.runTitle.value).toBe("dark editorial");
    expect(s.runStatus.value).toBe("queued");
    expect(s.queuePosition.value).toBe(3);
    expect(s.total.value).toBe(6);
    expect(s.running.value).toBe(true); // a queued run is still cancellable
  });
});

describe("selection persistence", () => {
  it("remembers ticked models, prompts and quantities across a reload", () => {
    localStorage.setItem("redesign.sel-models", JSON.stringify(["m1"]));
    localStorage.setItem("redesign.sel-prompts", JSON.stringify(["p1"]));
    localStorage.setItem("redesign.model-qty", JSON.stringify({ m1: 3 }));

    const s = createControlState();

    expect(s.selModels.value).toEqual(["m1"]);
    expect(s.selPrompts.value).toEqual(["p1"]);
    expect(s.modelQty.value).toEqual({ m1: 3 });
  });

  it("never remembers the input selection or the mock flag", () => {
    const s = createControlState();
    s.selInputs.value = ["i1"];
    s.mock.value = true;

    expect(localStorage.getItem("redesign.sel-inputs")).toBeNull();
    expect(localStorage.getItem("redesign.mock")).toBeNull();
    // a fresh load starts clean on both
    const next = createControlState();
    expect(next.selInputs.value).toEqual([]);
    expect(next.mock.value).toBe(false);
  });

  it("round-trips the focused run id, and clearing it does not leave a truthy 'null' behind", async () => {
    const s = createControlState();
    s.focusedRunId.value = "run1";
    await nextTick(); // useStorage writes on the watcher's flush, not synchronously
    expect(localStorage.getItem("redesign.focused-run")).toContain("run1");
    expect(createControlState().focusedRunId.value).toBe("run1");

    s.focusedRunId.value = null;
    await nextTick();
    // A literal "null" string would read back TRUTHY on the next load and send
    // resumeRuns hunting for a run whose id is the word "null".
    expect(localStorage.getItem("redesign.focused-run")).not.toBe("null");
    expect(createControlState().focusedRunId.value).toBeNull();
  });

  it("starts unseeded so bootstrap knows to preselect every runnable model once", () => {
    expect(createControlState().selectionSeeded.value).toBe(false);
    localStorage.setItem("redesign.selection-seeded", "true");
    expect(createControlState().selectionSeeded.value).toBe(true);
  });
});

describe("brand style guide persistence", () => {
  it("adopts the saved default when the working guide is empty", () => {
    localStorage.setItem("redesign.brand-style-guide-default", "house brand rules");

    const s = createControlState();

    expect(s.brandStyleGuide.value).toBe("house brand rules");
  });

  it("leaves an existing working guide alone", () => {
    // A per-run override must survive, that is the whole reason default and working are separate.
    localStorage.setItem("redesign.brand-style-guide-default", "house brand rules");
    localStorage.setItem("redesign.brand-style-guide", "one-off override");

    const s = createControlState();

    expect(s.brandStyleGuide.value).toBe("one-off override");
  });

  it("stays empty when there is no default to adopt", () => {
    const s = createControlState();

    expect(s.brandStyleGuide.value).toBe("");
  });
});

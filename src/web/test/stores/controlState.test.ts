import { describe, it, expect, beforeEach } from "vitest";
import { createControlState, isRunnable, errMessage } from "@/stores/control/state";
import { ApiError } from "@/lib/httpClient";
import type { Job, JobStatus, Model } from "@/types";

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
    s.jobs.set("a", job("a", "ok"));
    s.jobs.set("b", job("b", "error"));
    s.jobs.set("c", job("c", "skipped"));
    s.jobs.set("d", job("d", "running"));
    s.total.value = 4;

    expect(s.progress.value).toEqual({ done: 3, ok: 1, error: 1, skipped: 1, total: 4, pct: 75 });
  });

  it("folds cancelled in with skipped", () => {
    const s = createControlState();
    s.jobs.set("a", job("a", "cancelled"));
    s.total.value = 1;

    expect(s.progress.value).toMatchObject({ done: 1, skipped: 1, ok: 0, error: 0, pct: 100 });
  });

  it("treats pending and queued as not started", () => {
    const s = createControlState();
    s.jobs.set("a", job("a", "pending"));
    s.jobs.set("b", job("b", "queued"));
    s.total.value = 2;

    expect(s.progress.value).toMatchObject({ done: 0, pct: 0, total: 2 });
  });

  it("prefers the declared total over the job count, so a partial stream reads honestly", () => {
    const s = createControlState();
    s.jobs.set("a", job("a", "ok"));
    s.total.value = 10; // the run declares 10 jobs; only one has streamed in so far

    expect(s.progress.value).toMatchObject({ done: 1, total: 10, pct: 10 });
  });

  it("falls back to the job count when no total is declared", () => {
    const s = createControlState();
    s.jobs.set("a", job("a", "ok"));
    s.jobs.set("b", job("b", "running"));

    expect(s.progress.value).toMatchObject({ done: 1, total: 2, pct: 50 });
  });

  it("rounds the percentage", () => {
    const s = createControlState();
    s.jobs.set("a", job("a", "ok"));
    s.jobs.set("b", job("b", "running"));
    s.jobs.set("c", job("c", "running"));

    expect(s.progress.value.pct).toBe(33);
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

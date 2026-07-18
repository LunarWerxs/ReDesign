import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick } from "vue";

// starTally binds its useStorage ref at module scope, so each test needs a fresh module
// registry to re-read localStorage rather than inherit the previous test's entries.
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const fresh = () => import("@/lib/starTally");

const KEY = "reimagine.starTally";

/** Seed persisted entries as if earlier sessions had recorded them. */
function seed(entries: { runId: string; model: string }[]) {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

describe("recordFirstStar", () => {
  it("records a run's first star", async () => {
    const { recordFirstStar, hasFirstStar, starTallyEntries } = await fresh();

    recordFirstStar("run1", "Model One");

    expect(hasFirstStar("run1")).toBe(true);
    expect(starTallyEntries.value).toEqual([{ runId: "run1", model: "Model One" }]);
  });

  it("ignores later stars in a run it already knows", async () => {
    const { recordFirstStar, starTallyEntries } = await fresh();

    recordFirstStar("run1", "Model One");
    recordFirstStar("run1", "Model Two");

    // The tally is about which model was starred FIRST, so the second must not overwrite it.
    expect(starTallyEntries.value).toEqual([{ runId: "run1", model: "Model One" }]);
  });

  it("records each run separately", async () => {
    const { recordFirstStar, starTallyEntries } = await fresh();

    recordFirstStar("run1", "A");
    recordFirstStar("run2", "B");

    expect(starTallyEntries.value).toHaveLength(2);
  });

  it("ignores a blank run id or model", async () => {
    const { recordFirstStar, starTallyEntries } = await fresh();

    recordFirstStar("", "A");
    recordFirstStar("run1", "");

    expect(starTallyEntries.value).toEqual([]);
  });

  it("keeps only the last 20 runs", async () => {
    const { recordFirstStar, starTallyEntries } = await fresh();

    for (let i = 0; i < 25; i++) recordFirstStar(`run${i}`, `M${i}`);

    // Recent form, not all-time trivia: the oldest five fall off the front.
    expect(starTallyEntries.value).toHaveLength(20);
    expect(starTallyEntries.value[0]).toEqual({ runId: "run5", model: "M5" });
    expect(starTallyEntries.value.at(-1)).toEqual({ runId: "run24", model: "M24" });
  });
});

describe("hasFirstStar", () => {
  it("is false for an unknown run", async () => {
    const { hasFirstStar } = await fresh();

    expect(hasFirstStar("nope")).toBe(false);
  });

  it("sees runs restored from a previous session", async () => {
    seed([{ runId: "old", model: "A" }]);
    const { hasFirstStar } = await fresh();

    expect(hasFirstStar("old")).toBe(true);
  });
});

describe("persistence", () => {
  it("writes entries to localStorage", async () => {
    const { recordFirstStar } = await fresh();

    recordFirstStar("run1", "A");
    await nextTick();

    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([{ runId: "run1", model: "A" }]);
  });

  it("exposes the storage key it uses", async () => {
    const { STAR_TALLY_STORAGE_KEY } = await fresh();

    expect(STAR_TALLY_STORAGE_KEY).toBe(KEY);
  });
});

describe("starTallyReadout", () => {
  it("is null with no entries", async () => {
    const { starTallyReadout } = await fresh();

    expect(starTallyReadout.value).toBeNull();
  });

  it("names the model that led most often", async () => {
    seed([
      { runId: "r1", model: "Alpha" },
      { runId: "r2", model: "Beta" },
      { runId: "r3", model: "Alpha" },
    ]);
    const { starTallyReadout } = await fresh();

    expect(starTallyReadout.value).toBe("Alpha starred first in 2 of your last 3 runs");
  });

  it("reads sensibly for a single run", async () => {
    seed([{ runId: "r1", model: "Alpha" }]);
    const { starTallyReadout } = await fresh();

    expect(starTallyReadout.value).toBe("Alpha starred first in 1 of your last 1 runs");
  });

  it("updates as new stars land", async () => {
    const { recordFirstStar, starTallyReadout } = await fresh();

    recordFirstStar("r1", "Alpha");
    expect(starTallyReadout.value).toBe("Alpha starred first in 1 of your last 1 runs");

    recordFirstStar("r2", "Beta");
    recordFirstStar("r3", "Beta");
    expect(starTallyReadout.value).toBe("Beta starred first in 2 of your last 3 runs");
  });
});

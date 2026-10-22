import { describe, it, expect } from "vitest";
import { toggleIn } from "@/lib/array";

describe("toggleIn", () => {
  it("appends an id that is absent", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn([], "a")).toEqual(["a"]);
  });

  it("removes an id that is present", () => {
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleIn(["a"], "a")).toEqual([]);
  });

  it("returns a new array instead of mutating the input", () => {
    // Callers assign the result into reactive state, so the input must stay untouched.
    const input = ["a"];
    const added = toggleIn(input, "b");
    const removed = toggleIn(input, "a");

    expect(input).toEqual(["a"]);
    expect(added).not.toBe(input);
    expect(removed).not.toBe(input);
  });

  it("removes every duplicate of the id, not just the first", () => {
    expect(toggleIn(["a", "b", "a"], "a")).toEqual(["b"]);
  });
});

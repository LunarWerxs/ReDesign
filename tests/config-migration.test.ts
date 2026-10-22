import { expect, test } from "bun:test";
import { mergeShippedRecords } from "../src/config/migration";

test("shipped model fixes update untouched records, add new records, and retain archived tombstones", () => {
  const previous = [{ id: "stable", label: "Old" }, { id: "archived", label: "Archived" }];
  const current = [{ id: "stable", label: "Old" }, { id: "custom", label: "Mine" }];
  const shipped = [{ id: "stable", label: "Fixed" }, { id: "archived", label: "Newer" }, { id: "added", label: "Added" }];
  expect(mergeShippedRecords(current, previous, shipped, ["archived"])).toEqual([
    { id: "stable", label: "Fixed" }, { id: "custom", label: "Mine" }, { id: "added", label: "Added" },
  ]);
});

test("shipped migration never overwrites a user-edited record or revives a deleted old record", () => {
  const previous = [{ id: "edited", label: "Original" }, { id: "deleted", label: "Original" }];
  const current = [{ id: "edited", label: "Personal" }];
  const shipped = [{ id: "edited", label: "Fixed" }, { id: "deleted", label: "Fixed" }, { id: "new", label: "New" }];
  expect(mergeShippedRecords(current, previous, shipped)).toEqual([
    { id: "edited", label: "Personal" }, { id: "new", label: "New" },
  ]);
});

type ShippedRecord = { id?: unknown; [key: string]: unknown };

/** Merge a new shipped catalog without overwriting edits or reviving tombstones. */
export function mergeShippedRecords(
  current: ShippedRecord[],
  previous: ShippedRecord[],
  shipped: ShippedRecord[],
  tombstones: Iterable<string> = [],
): ShippedRecord[] {
  const oldById = new Map(previous.map((item) => [String(item.id || ""), item]));
  const currentById = new Map(current.map((item) => [String(item.id || ""), item]));
  const blocked = new Set(tombstones);
  const merged = [...current];
  for (const next of shipped) {
    const id = String(next.id || "");
    if (!id || blocked.has(id)) continue;
    const existing = currentById.get(id);
    if (!existing) {
      if (!oldById.has(id)) merged.push(next);
      continue;
    }
    const old = oldById.get(id);
    if (old && JSON.stringify(existing) === JSON.stringify(old)) {
      const index = merged.findIndex((item) => String(item.id || "") === id);
      if (index >= 0) merged[index] = next;
    }
  }
  return merged;
}

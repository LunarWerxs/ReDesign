// Global test setup. Provides a clean, spec-compliant in-memory localStorage: happy-dom's Storage
// and Node's experimental `--localstorage-file` localStorage can shadow each other (the latter
// exposes no `clear()` and throws without a file path), which breaks @vueuse's useStorage that the
// control state and the star tally build on. A simple Map-backed Storage sidesteps both.
//
// Mirrors RepoYeti's web/test/setup.ts, same reason, same shape.
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
}

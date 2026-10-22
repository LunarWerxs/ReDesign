import { describe, expect, it } from "bun:test";
import { withProviderRun, providerCall } from "../src/provider-call";

describe("provider calls", () => {
  it("serializes the same physical key across pools", async () => {
    const order: string[] = [];
    await Promise.all([
      providerCall({ pool: "flash", apiKey: "same", signal: null }, async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first-end");
        return 1;
      }),
      providerCall({ pool: "pro", apiKey: "same", signal: null }, async () => {
        order.push("second-start");
        order.push("second-end");
        return 2;
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("records an empty billed response without inventing usage", async () => {
    const entries: unknown[] = [];
    await withProviderRun({ recordUsage: (entry) => entries.push(entry) }, async () => {
      await expect(providerCall({ pool: "x", apiKey: "key", modelId: "m", provider: "p", signal: null }, async () => {
        const error = new Error("empty") as Error & { usage?: unknown };
        error.usage = { prompt_tokens: 12, completion_tokens: 0 };
        throw error;
      })).rejects.toThrow("empty");
    });
    expect(entries).toEqual([expect.objectContaining({ modelId: "m", usage: { prompt_tokens: 12, completion_tokens: 0 }, partial: false })]);
  });

  it("restores configured concurrency after an earlier run drains", async () => {
    await withProviderRun({ concurrency: 1 }, () => providerCall({ pool: "restore", apiKey: "first" }, async () => ({ usage: null })));
    let active = 0;
    let peak = 0;
    await Promise.all(["second", "third"].map((apiKey) => providerCall({ pool: "restore", apiKey }, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { usage: null };
    })));
    expect(peak).toBe(2);
  });

  it("does not spend a network slot while waiting for the same physical key", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let otherStarted = false;
    await withProviderRun({ concurrency: 2, poolConcurrency: 2 }, async () => {
      const first = providerCall({ pool: "wait", apiKey: "shared" }, async () => {
        await firstDone;
        return { usage: null };
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const waiting = providerCall({ pool: "wait", apiKey: "shared" }, async () => ({ usage: null }));
      const other = providerCall({ pool: "wait", apiKey: "other" }, async () => {
        otherStarted = true;
        return { usage: null };
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(otherStarted).toBe(true);
      releaseFirst();
      await Promise.all([first, waiting, other]);
    });
  });
});

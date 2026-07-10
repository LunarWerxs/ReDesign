import { describe, it, expect } from "bun:test";
import * as util from "../src/util";
import { buildPoolLimits, runJobsByPool } from "../src/runner";

describe("util: key parsing & helpers", () => {
  it("getKeyPool merges comma + indexed, trims, dedupes", () => {
    process.env.__TESTPOOL = "a, b ,c,";
    process.env.__TESTPOOL_1 = "d";
    process.env.__TESTPOOL_2 = "e,f";
    expect(util.getKeyPool("__TESTPOOL").sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("maskKey hides the middle", () => {
    const masked = util.maskKey("sk-1234567890abcdef");
    expect(masked.includes("...")).toBe(true);
    expect(masked.includes("567890")).toBe(false);
  });

  it("keyId is stable", () => {
    expect(util.keyId("hello")).toBe(util.keyId("hello"));
  });

  it("keyId differs per key", () => {
    expect(util.keyId("a")).not.toBe(util.keyId("b"));
  });

  it("slugify", () => {
    expect(util.slugify("Screenshot 2026!!.png")).toBe("Screenshot-2026.png");
  });

  it("mapLimit respects the concurrency cap and captures per-item errors without rejecting", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await util.mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await util.sleep(10);
      inFlight--;
      if (x === 3) throw new Error("boom");
      return x * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(res[2]!.ok).toBe(false);
    expect((res[0] as { ok: true; value: number }).value).toBe(2);
  });

  it("buildPoolLimits caps per-pool concurrency by key count and max", () => {
    const fakePoolLimits = buildPoolLimits(
      [{ keyEnv: "POOL_A" }, { keyEnv: "POOL_B" }, { keyEnv: "POOL_A" }, { keyEnv: "POOL_EMPTY" }] as any,
      { poolSize: (name: string) => ({ POOL_A: 3, POOL_B: 10, POOL_EMPTY: 0 } as Record<string, number>)[name] || 0 },
      4
    );
    expect(Object.fromEntries(fakePoolLimits)).toEqual({ POOL_A: 3, POOL_B: 4, POOL_EMPTY: 1 });
  });

  it("runJobsByPool respects the total concurrency cap and per-pool caps", async () => {
    let activeTotal = 0;
    let maxActiveTotal = 0;
    const activeByPool: Record<string, number> = {};
    const maxActiveByPool: Record<string, number> = {};
    await runJobsByPool(
      [
        { id: "a1", pool: "a" }, { id: "a2", pool: "a" }, { id: "a3", pool: "a" }, { id: "a4", pool: "a" },
        { id: "b1", pool: "b" }, { id: "b2", pool: "b" }, { id: "b3", pool: "b" },
      ],
      {
        totalConcurrency: 3,
        poolLimits: new Map([["a", 2], ["b", 1]]),
        keyFor: (job: { pool: string }) => job.pool,
        worker: async (job: { pool: string }) => {
          activeTotal++;
          activeByPool[job.pool] = (activeByPool[job.pool] || 0) + 1;
          maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
          maxActiveByPool[job.pool] = Math.max(maxActiveByPool[job.pool] || 0, activeByPool[job.pool]!);
          await util.sleep(10);
          activeByPool[job.pool]!--;
          activeTotal--;
        },
      }
    );
    expect(maxActiveTotal).toBeLessThanOrEqual(3);
    expect(maxActiveByPool.a).toBeLessThanOrEqual(2);
    expect(maxActiveByPool.b).toBeLessThanOrEqual(1);
  });
});

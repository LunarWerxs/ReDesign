import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyManager, CLASS } from "../src/keyManager";
import { withKeyRotation } from "../src/runner/helpers";
import type { KeyAttemptContext } from "../src/runner/helpers";
import { ProviderError } from "../src/providers";

describe("withKeyRotation + KeyManager.availableCount/attemptBudget", () => {
  const tmpState = path.join(os.tmpdir(), `reimagine-test-key-rotation-${process.pid}.json`);

  afterAll(() => {
    for (const suffix of [".a", ".b", ".c", ".d", ".e", ".f", ".g", ".h"]) {
      try { fs.unlinkSync(tmpState + suffix); } catch (_) {}
    }
  });

  it("rotates past dead keys and succeeds on the third distinct key", async () => {
    const POOL = "TESTPOOL_ROT_KEYS";
    process.env[POOL] = "r1,r2,r3,r4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.a` });
      let calls = 0;
      const seenKeys: string[] = [];
      const attempt = async (ctx: KeyAttemptContext): Promise<string> => {
        calls++;
        seenKeys.push(ctx.apiKey);
        if (calls <= 2) throw new ProviderError("dead", { errorClass: CLASS.AUTH, status: 401 });
        return "success-value";
      };
      const result = await withKeyRotation(km, POOL, attempt);
      expect(result).toBe("success-value");
      expect(calls).toBe(3);
      expect(new Set(seenKeys).size).toBe(3);
    } finally {
      delete process.env[POOL];
    }
  });

  it("the two failed keys are cooling and marked dead in the snapshot", async () => {
    const POOL = "TESTPOOL_COOL_KEYS";
    process.env[POOL] = "c1,c2,c3,c4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.b` });
      let calls = 0;
      const attempt = async (): Promise<string> => {
        calls++;
        if (calls <= 2) throw new ProviderError("dead", { errorClass: CLASS.AUTH, status: 401 });
        return "success-value";
      };
      await withKeyRotation(km, POOL, attempt);
      expect(km.availableCount(POOL)).toBe(2);
      expect(km.snapshot().pools[0]!.entries.filter((e) => e.status === "dead").length).toBe(2);
    } finally {
      delete process.env[POOL];
    }
  });

  it("a BAD_REQUEST is not rotated to another key: one attempt, null result", async () => {
    const POOL = "TESTPOOL_BADREQ_KEYS";
    process.env[POOL] = "q1,q2,q3,q4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.c` });
      let calls = 0;
      const attempt = async (): Promise<string> => {
        calls++;
        throw new ProviderError("bad", { errorClass: CLASS.BAD_REQUEST, status: 400 });
      };
      const result = await withKeyRotation(km, POOL, attempt);
      expect(result).toBeNull();
      expect(calls).toBe(1);
    } finally {
      delete process.env[POOL];
    }
  });

  it("exhausting every key in the pool returns null after exactly one attempt per key", async () => {
    const POOL = "TESTPOOL_EXHAUST_KEYS";
    process.env[POOL] = "e1,e2,e3";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.d` });
      let calls = 0;
      const attempt = async (): Promise<string> => {
        calls++;
        throw new ProviderError("dead", { errorClass: CLASS.AUTH, status: 401 });
      };
      const result = await withKeyRotation(km, POOL, attempt);
      expect(result).toBeNull();
      expect(calls).toBe(3);
    } finally {
      delete process.env[POOL];
    }
  });

  it("an empty pool returns null without ever calling attempt", async () => {
    const POOL = "TESTPOOL_EMPTY_KEYS";
    const km = new KeyManager({ stateFile: `${tmpState}.e` });
    let calls = 0;
    const attempt = async (): Promise<string> => {
      calls++;
      return "unreachable";
    };
    const result = await withKeyRotation(km, POOL, attempt);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("a non-ProviderError bug is not retried and does not blame the key", async () => {
    const POOL = "TESTPOOL_BUG_KEYS";
    process.env[POOL] = "u1,u2,u3,u4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.f` });
      let calls = 0;
      const attempt = async (): Promise<string> => {
        calls++;
        throw new Error("boom");
      };
      const result = await withKeyRotation(km, POOL, attempt);
      expect(result).toBeNull();
      expect(calls).toBe(1);
      // BAD_REQUEST has a 0 cooldown, so the key our own bug happened to be
      // holding is never penalized: the whole pool stays available.
      expect(km.availableCount(POOL)).toBe(4);
    } finally {
      delete process.env[POOL];
    }
  });

  it("attemptBudget is the whole pool bounded by the cap, and never 0 for an empty pool", () => {
    const POOL = "TESTPOOL_BUDGET_KEYS";
    process.env[POOL] = "b1,b2,b3,b4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.g` });
      expect(km.attemptBudget(POOL, 10)).toBe(4);
      expect(km.attemptBudget(POOL, 2)).toBe(2);

      const EMPTY_POOL = "TESTPOOL_BUDGET_EMPTY_KEYS";
      expect(km.attemptBudget(EMPTY_POOL)).toBe(1);
    } finally {
      delete process.env[POOL];
    }
  });

  it("an already-aborted signal stops rotation before any attempt runs", async () => {
    const POOL = "TESTPOOL_ABORT_KEYS";
    process.env[POOL] = "s1,s2,s3,s4";
    try {
      const km = new KeyManager({ stateFile: `${tmpState}.h` });
      let calls = 0;
      const attempt = async (): Promise<string> => {
        calls++;
        return "unreachable";
      };
      const controller = new AbortController();
      controller.abort();
      const result = await withKeyRotation(km, POOL, attempt, { signal: controller.signal });
      expect(result).toBeNull();
      expect(calls).toBe(0);
    } finally {
      delete process.env[POOL];
    }
  });
});

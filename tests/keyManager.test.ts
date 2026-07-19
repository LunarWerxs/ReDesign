import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyManager, CLASS } from "../src/keyManager";
import { keyId } from "../src/util";

describe("keyManager: rotation, cooldown, classification, persistence", () => {
  const tmpState = path.join(os.tmpdir(), `reimagine-test-${process.pid}.json`);

  afterAll(() => {
    for (const suffix of ["", ".2", ".3", ".4", ".5", ".6", ".e2e", ".e2e2", ".rot", ".ref"]) {
      try { fs.unlinkSync(tmpState + suffix); } catch (_) {}
    }
  });

  it("round-robin cycles through all 3 keys and the order repeats", () => {
    try { fs.unlinkSync(tmpState); } catch (_) {}
    const km = new KeyManager({ stateFile: tmpState });
    km.registerPool("ANTHROPIC_API_KEYS"); // 3 keys

    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = km.acquire("ANTHROPIC_API_KEYS");
      picks.push(a.keyId as string);
      km.report("ANTHROPIC_API_KEYS", a.keyId as string, { errorClass: CLASS.OK });
    }
    expect(new Set(picks).size).toBe(3);
    expect(picks[0]).toBe(picks[3]);
  });

  it("dead key is skipped by acquire and marked dead in the snapshot; snapshot never leaks the secret", () => {
    const km = new KeyManager({ stateFile: tmpState });
    km.registerPool("ANTHROPIC_API_KEYS");
    for (let i = 0; i < 6; i++) {
      const a = km.acquire("ANTHROPIC_API_KEYS");
      km.report("ANTHROPIC_API_KEYS", a.keyId as string, { errorClass: CLASS.OK });
    }

    const a1 = km.acquire("ANTHROPIC_API_KEYS");
    km.report("ANTHROPIC_API_KEYS", a1.keyId as string, { errorClass: CLASS.AUTH, message: "401" });
    const after: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = km.acquire("ANTHROPIC_API_KEYS");
      if (a.available) after.push(a.keyId as string);
    }
    expect(after.includes(a1.keyId as string)).toBe(false);
    expect(new Set(after).size).toBe(2);

    const snap = km.snapshot().pools[0]!;
    expect(snap.entries.find((e) => e.id === a1.keyId)!.status).toBe("dead");
    expect(JSON.stringify(km.snapshot()).includes("sk-ant-aaa1")).toBe(false);

    km.save();
    const reloaded = new KeyManager({ stateFile: tmpState });
    reloaded.registerPool("ANTHROPIC_API_KEYS");
    const rsnap = reloaded.snapshot().pools[0]!;
    expect(rsnap.entries.find((e) => e.id === a1.keyId)!.status).toBe("dead");
  });

  it("all-cooldown returns available=false with waitMs", () => {
    const km2 = new KeyManager({ stateFile: `${tmpState}.2` });
    km2.registerPool("OPENAI_API_KEYS"); // 2 keys
    for (let i = 0; i < 2; i++) {
      const a = km2.acquire("OPENAI_API_KEYS");
      km2.report("OPENAI_API_KEYS", a.keyId as string, { errorClass: CLASS.RATE_LIMIT });
    }
    const none = km2.acquire("OPENAI_API_KEYS");
    expect(none.available).toBe(false);
    expect(none.reason).toBe("all_cooldown");
    expect(none.waitMs).toBeGreaterThan(0);
  });

  it("explicit retryAfter drives cooldown", () => {
    const km3 = new KeyManager({ stateFile: `${tmpState}.3` });
    km3.registerPool("DEEPSEEK_API_KEYS");
    const ad = km3.acquire("DEEPSEEK_API_KEYS");
    km3.report("DEEPSEEK_API_KEYS", ad.keyId as string, { errorClass: CLASS.RATE_LIMIT, retryAfterMs: 2000 });
    const cd = km3.snapshot().pools[0]!.entries.find((e) => e.id === ad.keyId)!.cooldownRemainingSec;
    expect(cd).toBeGreaterThanOrEqual(1);
    expect(cd).toBeLessThanOrEqual(3);
  });

  it("bad_request leaves the key available (0 cooldown)", () => {
    const km4 = new KeyManager({ stateFile: `${tmpState}.4` });
    km4.registerPool("OPENAI_API_KEYS");
    const ab = km4.acquire("OPENAI_API_KEYS");
    km4.report("OPENAI_API_KEYS", ab.keyId as string, { errorClass: CLASS.BAD_REQUEST, message: "400" });
    expect(km4.acquire("OPENAI_API_KEYS").available).toBe(true);
  });

  it("AUTH / NO_BALANCE keep their long cooldown even if a Retry-After is present", () => {
    const km5 = new KeyManager({ stateFile: `${tmpState}.5` });
    km5.registerPool("DEEPSEEK_API_KEYS");
    const aAuth = km5.acquire("DEEPSEEK_API_KEYS");
    km5.report("DEEPSEEK_API_KEYS", aAuth.keyId as string, { errorClass: CLASS.AUTH, retryAfterMs: 2000, message: "401" });
    const authCd = km5.snapshot().pools[0]!.entries.find((e) => e.id === aAuth.keyId)!.cooldownRemainingSec;
    expect(authCd).toBeGreaterThan(3600);

    const aBal = km5.acquire("DEEPSEEK_API_KEYS");
    km5.report("DEEPSEEK_API_KEYS", aBal.keyId as string, { errorClass: CLASS.NO_BALANCE, retryAfterMs: 2000, message: "402" });
    const balCd = km5.snapshot().pools[0]!.entries.find((e) => e.id === aBal.keyId)!.cooldownRemainingSec;
    expect(balCd).toBeGreaterThan(1800);
  });

  it("a physical key shared across two pools is propagated as dead to both", () => {
    process.env.GEMINI_FLASH_API_KEYS = "AIza-shared-xyz,AIza-flash-only";
    process.env.GEMINI_PRO_API_KEYS = "AIza-shared-xyz,AIza-pro-only";
    const km6 = new KeyManager({ stateFile: `${tmpState}.6` });
    km6.registerPool("GEMINI_FLASH_API_KEYS");
    km6.registerPool("GEMINI_PRO_API_KEYS");
    const sharedId = keyId("AIza-shared-xyz");
    km6.report("GEMINI_FLASH_API_KEYS", sharedId, { errorClass: CLASS.AUTH, message: "403" });
    const proShared = km6
      .snapshot()
      .pools.find((p) => p.pool === "GEMINI_PRO_API_KEYS")!
      .entries.find((e) => e.id === sharedId)!;
    expect(proShared.status).toBe("dead");
    expect(proShared.availableNow).toBe(false);
  });
});

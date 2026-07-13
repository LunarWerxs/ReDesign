import { test, expect } from "bun:test";
import {
  classifyKeyPrefix,
  parseKeyBlob,
  providerToBrand,
  servicesFromModels,
  poolsForBrand,
  resolveKeyBrand,
} from "../src/keyDetect";

// ---------------------------------------------------------------------------
// Prefix classification: the confident, offline half of auto-detect.
// ---------------------------------------------------------------------------
test("classifyKeyPrefix routes confident prefixes to their brand", () => {
  expect(classifyKeyPrefix("sk-ant-api03-abcdefgh1234")).toEqual({ brand: "anthropic", ambiguous: false });
  expect(classifyKeyPrefix("AIzaSyA-abcdefghijklmnopqrstuvwxyz012")).toEqual({ brand: "google", ambiguous: false });
  expect(classifyKeyPrefix("sk-proj-abcdefghijklmnop")).toEqual({ brand: "openai", ambiguous: false });
  expect(classifyKeyPrefix("sk-svcacct-abcdefghijklmnop")).toEqual({ brand: "openai", ambiguous: false });
  expect(classifyKeyPrefix("xai-abcdefghijklmnopqrst")).toEqual({ brand: "xai", ambiguous: false });
  expect(classifyKeyPrefix("sk-or-v1-abcdefghijklmnop")).toEqual({ brand: "openrouter", ambiguous: false });
  expect(classifyKeyPrefix("gsk_abcdefghijklmnopqrstuvwx")).toEqual({ brand: "groq", ambiguous: false });
  // Meta AI (Muse Spark) keys are LLM_<16-digit app_id>_<secret>.
  expect(classifyKeyPrefix("LLM_1234567890123456_abcdefghijklmnop")).toEqual({ brand: "metaai", ambiguous: false });
});

test("resolveKeyBrand routes an LLM_ key to metaai with no probe", async () => {
  const services = servicesFromModels([
    { provider: "metaai", keyEnv: "METAAI_API_KEYS", baseUrl: "https://api.meta.ai/v1" },
  ]);
  const r = await resolveKeyBrand("LLM_1234567890123456_abcdefghijklmnop", services);
  expect(r).toEqual({ brand: "metaai", probed: false });
  expect(poolsForBrand("metaai", services)).toEqual(["METAAI_API_KEYS"]);
});

test("classifyKeyPrefix marks a bare sk- as ambiguous (needs a probe)", () => {
  const r = classifyKeyPrefix("sk-abcdefghijklmnopqrstuvwx");
  expect(r.brand).toBeNull();
  expect(r.ambiguous).toBe(true);
});

test("classifyKeyPrefix returns unknown (not ambiguous) for an unrecognized shape", () => {
  // A Mistral-style raw hex key has no sk-/AIza/xai- prefix.
  const r = classifyKeyPrefix("0123456789abcdef0123456789abcdef");
  expect(r.brand).toBeNull();
  expect(r.ambiguous).toBe(false);
});

// The sk-or-v1- prefix must win over the bare sk- catch (ordering matters).
test("classifyKeyPrefix does not mislabel sk-or-v1- as a bare sk-", () => {
  expect(classifyKeyPrefix("sk-or-v1-deadbeefdeadbeef").brand).toBe("openrouter");
});

// ---------------------------------------------------------------------------
// Blob parsing: accept the messy ways people paste keys.
// ---------------------------------------------------------------------------
test("parseKeyBlob splits on newlines, commas and spaces and dedupes", () => {
  const blob = `sk-ant-aaaaaaaaaaaaaaaa
sk-proj-bbbbbbbbbbbbbbbb, sk-proj-cccccccccccccccc  AIzaSy-dddddddddddddddddddd
sk-ant-aaaaaaaaaaaaaaaa`; // duplicate on purpose
  expect(parseKeyBlob(blob)).toEqual([
    "sk-ant-aaaaaaaaaaaaaaaa",
    "sk-proj-bbbbbbbbbbbbbbbb",
    "sk-proj-cccccccccccccccc",
    "AIzaSy-dddddddddddddddddddd",
  ]);
});

test("parseKeyBlob understands .env-style NAME=value and export lines", () => {
  const blob = `# my keys
export OPENAI_API_KEYS=sk-proj-aaaaaaaaaaaaaaaa
ANTHROPIC_API_KEYS="sk-ant-bbbbbbbbbbbbbbbb"
GEMINI_API_KEYS=AIzaSy-cccccccccccccccccccc`;
  expect(parseKeyBlob(blob)).toEqual([
    "sk-proj-aaaaaaaaaaaaaaaa",
    "sk-ant-bbbbbbbbbbbbbbbb",
    "AIzaSy-cccccccccccccccccccc",
  ]);
});

test("parseKeyBlob drops comment lines and too-short tokens", () => {
  expect(parseKeyBlob("# nothing here\nshort\nsk-proj-aaaaaaaaaaaaaaaa")).toEqual([
    "sk-proj-aaaaaaaaaaaaaaaa",
  ]);
});

// ---------------------------------------------------------------------------
// Brand / service mapping.
// ---------------------------------------------------------------------------
test("providerToBrand collapses same-service provider ids", () => {
  expect(providerToBrand("gemini")).toBe("google");
  expect(providerToBrand("google")).toBe("google");
  expect(providerToBrand("openai-compatible")).toBe("openai");
  expect(providerToBrand("deepseek")).toBe("deepseek");
});

test("servicesFromModels dedupes by pool and poolsForBrand spans every Gemini pool", () => {
  const services = servicesFromModels([
    { provider: "gemini", keyEnv: "GEMINI_FLASH_API_KEYS", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    { provider: "gemini", keyEnv: "GEMINI_PRO_API_KEYS", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
    { provider: "openai", keyEnv: "OPENAI_API_KEYS", baseUrl: "https://api.openai.com/v1" },
    { provider: "openai", keyEnv: "OPENAI_API_KEYS", baseUrl: "https://api.openai.com/v1" }, // dup pool
  ]);
  expect(services).toHaveLength(3);
  // A single Google key must fan out to both Gemini pools.
  expect(poolsForBrand("google", services).sort()).toEqual(["GEMINI_FLASH_API_KEYS", "GEMINI_PRO_API_KEYS"]);
  expect(poolsForBrand("openai", services)).toEqual(["OPENAI_API_KEYS"]);
});

// ---------------------------------------------------------------------------
// resolveKeyBrand: confident prefixes resolve with no network probe.
// ---------------------------------------------------------------------------
test("resolveKeyBrand resolves a confident prefix without probing", async () => {
  const services = servicesFromModels([
    { provider: "anthropic", keyEnv: "ANTHROPIC_API_KEYS", baseUrl: "https://api.anthropic.com/v1" },
  ]);
  const r = await resolveKeyBrand("sk-ant-api03-abcdefghijklmnop", services);
  expect(r).toEqual({ brand: "anthropic", probed: false });
});

test("resolveKeyBrand yields brand even when no service is configured for it", async () => {
  const r = await resolveKeyBrand("xai-abcdefghijklmnopqrst", []);
  expect(r.brand).toBe("xai");
  expect(r.probed).toBe(false);
});

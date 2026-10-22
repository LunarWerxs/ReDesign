/**
 * Coverage for util.ts's redactSecrets(), the single scrubber standing between a provider's error
 * text and everything that error text reaches: job.error on the manifest, GET /api/runs/:id, the
 * key-health detail in the UI, and the persisted key state. It had no tests at all before this file.
 *
 * Two mechanisms to hold down. The SHAPE patterns catch a key by prefix, and matter for a key this
 * process never loaded (someone else's key echoed back in an error body). The VALUE backstop catches
 * key formats no prefix can describe (Mistral is raw hex) by matching the concrete values getKeyPool
 * has seen. The value path is the one with teeth, because a careless version of it would happily
 * scramble ordinary prose.
 */
import { test, expect } from "bun:test";
import { redactSecrets, registerSecretValues } from "../src/util";

test("redacts every prefixed key shape it claims to", () => {
  const cases: Array<[string, string]> = [
    ["sk-ant-api03-AbCdEf012345_-xyz", "sk-ant-...REDACTED"],
    ["sk-proj-AbCdEf012345_-xyz", "sk-proj-...REDACTED"],
    ["AIzaSyA0123456789abcdefghijklmnop", "AIza...REDACTED"],
    ["xai-0123456789abcdefghij", "xai-...REDACTED"],
    ["gsk_0123456789abcdefghijklmn", "gsk_...REDACTED"],
    ["sk-or-v1-0123456789abcdefghij", "sk-...REDACTED"],
  ];
  for (const [key, expected] of cases) {
    const out = redactSecrets(`HTTP 401: invalid key ${key} rejected`);
    expect(out).toContain(expected);
    expect(out).not.toContain(key);
  }
});

test("redacts Meta AI's LLM_<appid>_<secret> shape", () => {
  const key = "LLM_1234567890_abcdefghijklmnopqrstuvwx";
  const out = redactSecrets(`provider said: ${key} is not authorized`) as string;
  expect(out).toContain("LLM_...REDACTED");
  expect(out).not.toContain(key);
});

test("redacts a registered key value that no prefix pattern would match (Mistral raw hex)", () => {
  // The whole point of the value backstop: nothing about this string looks like a key.
  const mistral = "3f9a2b7c4d1e806a5b2c9d4e7f0a1b3c";
  expect(redactSecrets(`HTTP 401 for ${mistral}`)).toContain(mistral); // not known yet
  registerSecretValues([mistral]);
  const out = redactSecrets(`HTTP 401 for ${mistral}`) as string;
  expect(out).not.toContain(mistral);
  expect(out).toContain("...REDACTED");
});

test("a longer key containing a shorter one leaves no readable tail", () => {
  // Longest-first replacement is what stops the short key from consuming its own prefix inside the
  // long one and leaving the remainder of the long key sitting in the output.
  const short = "abcdef123456789012";
  const long = `${short}TAILTAILTAIL`;
  registerSecretValues([short, long]);
  const out = redactSecrets(`saw ${long} here`) as string;
  expect(out).not.toContain(short);
  expect(out).not.toContain("TAILTAILTAIL");
});

test("does not corrupt ordinary text", () => {
  const prose = "The run finished. 12 outputs written to output/20260809-120000-abc/ in 3.4s.";
  expect(redactSecrets(prose)).toBe(prose);
});

test("ignores values too short to be a key, so they can never scramble prose", () => {
  // An empty or placeholder pool entry must not turn the scrubber into a find-and-replace on
  // common words. Anything under 12 chars is refused entry.
  registerSecretValues(["", "   ", "test", "localhost", "0123456789"]);
  const prose = "test run on localhost finished";
  expect(redactSecrets(prose)).toBe(prose);
});

test("passes through null, undefined and empty string unchanged", () => {
  expect(redactSecrets(null)).toBe(null);
  expect(redactSecrets(undefined)).toBe(undefined);
  expect(redactSecrets("")).toBe("");
});

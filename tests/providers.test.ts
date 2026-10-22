import { describe, it, expect } from "bun:test";
import { classifyHttp, ProviderError, requestJSON } from "../src/providers";
import { CLASS } from "../src/keyManager";

describe("http: error classification", () => {
  // Explicit invalid/revoked-credential evidence, whatever status it rides on.
  it.each([
    ["401", 401, ""],
    ["403 revoked key", 403, "This API key has been revoked"],
    ["403 explicitly invalid key", 403, "API key not valid. Please pass a valid API key."],
    ["403 explicitly invalid key code", 403, '{"error":{"code":"API_KEY_INVALID"}}'],
    ["400 invalid api key", 400, "Incorrect API key provided"],
  ])("%s → auth", (_case, status, body) => {
    expect(classifyHttp(status, new Headers(), body).errorClass).toBe(CLASS.AUTH);
  });

  it("403 resource permission → a non-retryable permission error without treating the credential as revoked", () => {
    const classified = classifyHttp(403, new Headers(), '{"error":{"type":"permission_error","code":"model_access_denied"}}');
    expect(classified.errorClass).toBe(CLASS.PERMISSION);
    expect(classified.providerType).toBe("permission_error");
    expect(classified.providerCode).toBe("model_access_denied");
    expect(new ProviderError("x", { errorClass: classified.errorClass }).retryable).toBe(false);
  });

  it("403 model permission mentioning an API key → permission, not auth", () => {
    expect(
      classifyHttp(403, new Headers(), "Your API key does not have permission to access this model").errorClass
    ).toBe(CLASS.PERMISSION);
  });

  it.each([
    ["402", 402, ""],
    ["429 insufficient_quota", 429, "You exceeded your current quota, insufficient_quota"],
    // A billing/account failure dressed up as a 400 must NOT be a bad_request (which
    // the runner won't retry), it's key-specific, so it maps to no_balance/auth and
    // the job rotates to a healthy key. Regression guard for the DashScope/Qwen bug.
    ["400 Arrearage", 400, "Access denied, please make sure your account is in good standing. overdue-payment. Arrearage"],
    ["400 insufficient balance", 400, "Insufficient Balance"],
  ])("%s → no_balance", (_case, status, body) => {
    expect(classifyHttp(status, new Headers(), body).errorClass).toBe(CLASS.NO_BALANCE);
  });

  it("429 plain → rate_limit", () => {
    expect(classifyHttp(429, new Headers(), "slow down").errorClass).toBe(CLASS.RATE_LIMIT);
  });

  it("400 → bad_request", () => {
    expect(classifyHttp(400, new Headers(), "bad json").errorClass).toBe(CLASS.BAD_REQUEST);
  });

  it("400 no_balance is retryable across keys", () => {
    const errorClass = classifyHttp(400, new Headers(), "Arrearage").errorClass;
    expect(new ProviderError("x", { errorClass }).retryable).toBe(true);
  });

  it("404 → bad_request", () => {
    expect(classifyHttp(404, new Headers(), "model not found").errorClass).toBe(CLASS.BAD_REQUEST);
  });

  it("529 → rate_limit (overloaded)", () => {
    expect(classifyHttp(529, new Headers(), "overloaded").errorClass).toBe(CLASS.RATE_LIMIT);
  });

  it("503 → server", () => {
    expect(classifyHttp(503, new Headers(), "").errorClass).toBe(CLASS.SERVER);
  });

  it("Retry-After header parsed to ms", () => {
    const ra = classifyHttp(429, new Headers({ "retry-after": "12" }), "");
    expect(ra.retryAfterMs).toBe(12000);
  });

  it("requestJSON preserves a 403 provider status, type, and code", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"error":{"type":"permission_error","code":"model_access_denied"}}', { status: 403 })) as unknown as typeof fetch;
    try {
      await expect(requestJSON("https://provider.invalid", {}, 1000, null)).rejects.toMatchObject({
        errorClass: CLASS.PERMISSION,
        status: 403,
        providerType: "permission_error",
        providerCode: "model_access_denied",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

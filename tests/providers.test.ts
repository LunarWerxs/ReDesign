import { describe, it, expect } from "bun:test";
import { classifyHttp, ProviderError } from "../src/providers";
import { CLASS } from "../src/keyManager";

describe("http: error classification", () => {
  it("401 → auth", () => {
    expect(classifyHttp(401, new Headers(), "").errorClass).toBe(CLASS.AUTH);
  });

  it("402 → no_balance", () => {
    expect(classifyHttp(402, new Headers(), "").errorClass).toBe(CLASS.NO_BALANCE);
  });

  it("429 plain → rate_limit", () => {
    expect(classifyHttp(429, new Headers(), "slow down").errorClass).toBe(CLASS.RATE_LIMIT);
  });

  it("429 insufficient_quota → no_balance", () => {
    expect(
      classifyHttp(429, new Headers(), "You exceeded your current quota, insufficient_quota").errorClass
    ).toBe(CLASS.NO_BALANCE);
  });

  it("400 → bad_request", () => {
    expect(classifyHttp(400, new Headers(), "bad json").errorClass).toBe(CLASS.BAD_REQUEST);
  });

  // A billing/account failure dressed up as a 400 must NOT be a bad_request (which
  // the runner won't retry), it's key-specific, so it maps to no_balance/auth and
  // the job rotates to a healthy key. Regression guard for the DashScope/Qwen bug.
  it("400 Arrearage → no_balance", () => {
    expect(
      classifyHttp(
        400,
        new Headers(),
        "Access denied, please make sure your account is in good standing. overdue-payment. Arrearage"
      ).errorClass
    ).toBe(CLASS.NO_BALANCE);
  });

  it("400 insufficient balance → no_balance", () => {
    expect(classifyHttp(400, new Headers(), "Insufficient Balance").errorClass).toBe(CLASS.NO_BALANCE);
  });

  it("400 invalid api key → auth", () => {
    expect(classifyHttp(400, new Headers(), "Incorrect API key provided").errorClass).toBe(CLASS.AUTH);
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
});

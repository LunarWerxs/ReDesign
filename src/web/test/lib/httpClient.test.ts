import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, httpFetch, httpJson } from "@/lib/httpClient";

/** Stub global fetch with a single canned Response. Returns the spy for call assertions. */
function stubFetch(res: Response) {
  const spy = vi.fn(async () => res);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status: number, statusText = "") =>
  new Response(JSON.stringify(body), { status, statusText });

/**
 * Await a call that must reject, returning the reason typed as ApiError. Fails loudly if the
 * call resolves instead, which a bare `.catch((e) => e)` would silently pass off as the reason.
 */
async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the request to reject, but it resolved");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpFetch", () => {
  it("returns the response unread on 2xx", async () => {
    stubFetch(json({ ok: true }, 200));

    const res = await httpFetch("/api/thing");

    expect(res.status).toBe(200);
    // The caller owns the body, so httpFetch must leave it unconsumed.
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("forwards url and init to fetch untouched", async () => {
    const spy = stubFetch(json({}, 200));
    const init = { method: "POST", body: "x" };

    await httpFetch("/api/thing", init);

    expect(spy).toHaveBeenCalledWith("/api/thing", init);
  });

  it("throws ApiError carrying status, code and body on non-2xx", async () => {
    stubFetch(json({ message: "nope", code: "E_NOPE" }, 400, "Bad Request"));

    const err = await rejection(httpFetch("/api/thing"));

    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(400);
    expect(err.message).toBe("nope");
    expect(err.code).toBe("E_NOPE");
    expect(err.body).toEqual({ message: "nope", code: "E_NOPE" });
  });

  it("falls back to the body's `error` field when there is no `message`", async () => {
    // The two shapes are the union of what the LunarWerx backends emit.
    stubFetch(json({ error: "boom" }, 500, "Internal Server Error"));

    const err = await rejection(httpFetch("/api/thing"));

    expect(err.message).toBe("boom");
    expect(err.code).toBeUndefined();
  });

  it("prefers `message` over `error` when a body carries both", async () => {
    stubFetch(json({ message: "precise", error: "vague" }, 400));

    const err = await rejection(httpFetch("/api/thing"));

    expect(err.message).toBe("precise");
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" }));

    const err = await rejection(httpFetch("/api/thing"));

    expect(err.status).toBe(502);
    expect(err.message).toBe("502 Bad Gateway");
    expect(err.body).toBeUndefined();
  });

  it("trims the status line when the response carries no statusText", async () => {
    stubFetch(new Response("nope", { status: 503 }));

    const err = await rejection(httpFetch("/api/thing"));

    expect(err.message).toBe("503");
  });
});

describe("httpJson", () => {
  it("parses and returns the JSON body", async () => {
    stubFetch(json({ id: 7, name: "run" }, 200));

    await expect(httpJson<{ id: number; name: string }>("/api/run")).resolves.toEqual({
      id: 7,
      name: "run",
    });
  });

  it("resolves to undefined for an empty body", async () => {
    stubFetch(new Response("", { status: 200 }));

    await expect(httpJson("/api/run")).resolves.toBeUndefined();
  });

  it("propagates ApiError from the underlying fetch", async () => {
    stubFetch(json({ message: "gone" }, 404, "Not Found"));

    const err = await rejection(httpJson("/api/run"));

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("gone");
  });
});

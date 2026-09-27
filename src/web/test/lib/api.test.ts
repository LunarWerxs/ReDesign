import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApiError,
  api,
  contrastUrl,
  designMdUrl,
  downloadUrl,
  encPath,
  eventsUrl,
  inputUrl,
  outputRawUrl,
  outputUrl,
  referenceUrl,
  runDownloadUrl,
  runThumbnailUrl,
  screenshotUrl,
} from "@/lib/api";
import { ApiError as HttpApiError } from "@/lib/httpClient";

/** Stub global fetch so every call answers with a fresh JSON Response. Returns the spy. */
function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encPath", () => {
  it("encodes each segment but keeps the slashes between them", () => {
    expect(encPath("run 1/a#b?c&d+e.html")).toBe("run%201/a%23b%3Fc%26d%2Be.html");
  });

  it("leaves a plain relative path untouched", () => {
    expect(encPath("run/result.html")).toBe("run/result.html");
  });
});

describe("file urls", () => {
  it("prefixes each static route and encodes the path segment by segment", () => {
    expect(inputUrl("shots/a b.png")).toBe("/input/shots/a%20b.png");
    expect(referenceUrl("ref #1.png")).toBe("/reference/ref%20%231.png");
    expect(outputUrl("run/x.html")).toBe("/output/run/x.html");
    expect(downloadUrl("run/x.html")).toBe("/output/run/x.html?download=1");
  });

  it("adds the measure flag to the raw output url only when asked", () => {
    expect(outputRawUrl("run/x.html")).toBe("/output-raw/run/x.html");
    expect(outputRawUrl("run/x.html", { measure: false })).toBe("/output-raw/run/x.html");
    expect(outputRawUrl("run/x.html", { measure: true })).toBe("/output-raw/run/x.html?measure=1");
  });

  it("passes the whole path as ONE query value for the screenshot and contrast reports", () => {
    // A query value, not a path, so the slash must be encoded too.
    expect(screenshotUrl("run/a b.html")).toBe("/api/output/screenshot?file=run%2Fa%20b.html");
    expect(contrastUrl("run/a&b.html")).toBe("/api/output/contrast?file=run%2Fa%26b.html");
  });

  it("encodes run and job ids as single path segments", () => {
    expect(runThumbnailUrl("r/1")).toBe("/api/runs/r%2F1/thumbnail");
    expect(eventsUrl("r 1")).toBe("/api/runs/r%201/events");
    expect(runDownloadUrl("r?1")).toBe("/api/runs/r%3F1/download");
    expect(designMdUrl("r/1", "j&2")).toBe("/api/runs/r%2F1/design-md?job=j%262");
  });
});

describe("api", () => {
  it("GETs a plain endpoint and returns the parsed body", async () => {
    const spy = stubFetch({ ok: true });

    await expect(api.authMe()).resolves.toEqual({ ok: true });

    expect(spy).toHaveBeenCalledWith("/api/auth/me", undefined);
  });

  it("POSTs a JSON body with the JSON content type", async () => {
    const spy = stubFetch({ runId: "r1" });

    await api.starModel("m1", true);

    expect(spy).toHaveBeenCalledWith("/api/models/star", jsonPost({ id: "m1", starred: true }));
  });

  it("sends each settings toggle as a PUT of its own single field", async () => {
    const spy = stubFetch({});

    await api.setAutoUpdate(true);
    await api.setOutputRetentionDays(30);

    expect(spy).toHaveBeenNthCalledWith(1, "/api/settings", { ...jsonPost({ autoUpdate: true }), method: "PUT" });
    expect(spy).toHaveBeenNthCalledWith(2, "/api/settings", {
      ...jsonPost({ outputRetentionDays: 30 }),
      method: "PUT",
    });
  });

  it("builds the available-models query from only the params it was given", async () => {
    const spy = stubFetch({ models: [] });

    await api.availableModels({ provider: "openai" });
    await api.availableModels({ provider: "custom", baseUrl: "https://x.test/v1", keyEnv: "MY_KEY" });

    expect(spy).toHaveBeenNthCalledWith(1, "/api/models/available?provider=openai", undefined);
    expect(spy).toHaveBeenNthCalledWith(
      2,
      "/api/models/available?provider=custom&baseUrl=https%3A%2F%2Fx.test%2Fv1&keyEnv=MY_KEY",
      undefined,
    );
  });

  it("pages runs with an encoded cursor, and omits the cursor on the first page", async () => {
    const spy = stubFetch({ runs: [] });

    await api.runs();
    await api.runs(null);
    await api.runs("2026-09-26T00:00:00Z|r 1");

    expect(spy).toHaveBeenNthCalledWith(1, "/api/runs?limit=50", undefined);
    expect(spy).toHaveBeenNthCalledWith(2, "/api/runs?limit=50", undefined);
    expect(spy).toHaveBeenNthCalledWith(3, "/api/runs?limit=50&cursor=2026-09-26T00%3A00%3A00Z%7Cr%201", undefined);
  });

  it("encodes the run id in per-run action routes", async () => {
    const spy = stubFetch({ ok: true });

    await api.cancelRun("r/1");
    await api.repeatRun("r/1");

    expect(spy).toHaveBeenNthCalledWith(1, "/api/runs/r%2F1/cancel", { method: "POST" });
    expect(spy).toHaveBeenNthCalledWith(2, "/api/runs/r%2F1/repeat", jsonPost({}));
  });

  it("forwards the abort signal on the health check", async () => {
    const spy = stubFetch({ results: [] });
    const controller = new AbortController();

    await api.healthCheck({ signal: controller.signal });

    expect(spy).toHaveBeenCalledWith("/api/health-check", {
      ...jsonPost({ models: "all" }),
      signal: controller.signal,
    });
  });

  it("rejects with the shared ApiError it re-exports on a non-2xx", async () => {
    stubFetch({ message: "run is still going" }, 409);

    const err = await api.retryRun("r1", {}).then(
      () => {
        throw new Error("expected the request to reject, but it resolved");
      },
      (e: unknown) => e,
    );

    expect(ApiError).toBe(HttpApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
    expect((err as InstanceType<typeof ApiError>).message).toBe("run is still going");
  });
});

import { expect, it } from "bun:test";
import { TOOLS } from "../src/mcp/tools";

it("guides a queued batch to get_run, which reads the same run without another submission", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method || "GET";
    const pathname = new URL(String(url)).pathname;
    requests.push({ method, path: pathname });
    if (method === "POST" && pathname === "/api/run") return Response.json({ runId: "fixture-run" });
    if (method === "GET" && pathname === "/api/runs/fixture-run") return Response.json({ runId: "fixture-run", status: "running" });
    throw new Error(`unexpected MCP request ${method} ${pathname}`);
  }) as typeof fetch;
  try {
    const batch = TOOLS.find((tool) => tool.name === "batch_reimagine")!;
    const result = await batch.run({ wait: false, mock: true }) as { runId: string; note: string };
    expect(result.runId).toBe("fixture-run");
    expect(result.note).toContain("get_run");
    expect(result.note).not.toContain("batch_reimagine");
    const read = TOOLS.find((tool) => tool.name === "get_run")!;
    expect(await read.run({ runId: result.runId })).toEqual({ runId: "fixture-run", status: "running" });
    expect(requests).toEqual([
      { method: "POST", path: "/api/run" },
      { method: "GET", path: "/api/runs/fixture-run" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("preflights a complete recipe then submits only its idempotency token", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/run/preflight") return Response.json({ preflightId: "prepared-1", jobCount: 2 });
    if (path === "/api/run") return Response.json({ runId: "run-1" });
    throw new Error(`unexpected MCP request ${path}`);
  }) as typeof fetch;
  try {
    const preflight = TOOLS.find((tool) => tool.name === "preflight_run")!;
    const run = TOOLS.find((tool) => tool.name === "run")!;
    expect(await preflight.run({ inputs: "shot", model_quantities: "gpt=2", max_cost: 3 })).toEqual({ preflightId: "prepared-1", jobCount: 2 });
    expect(await run.run({ preflight_id: "prepared-1" })).toEqual({ runId: "run-1" });
    expect(requests).toEqual([
      { path: "/api/run/preflight", body: expect.objectContaining({ inputs: "shot", modelQuantities: { gpt: 2 }, maxCostUsd: 3 }) },
      { path: "/api/run", body: { preflightId: "prepared-1" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("repeats a stored run through its dedicated endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ runId: "repeat-1" })) as unknown as typeof fetch;
  try {
    const repeat = TOOLS.find((tool) => tool.name === "repeat_run")!;
    expect(await repeat.run({ runId: "original" })).toEqual({ runId: "repeat-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { expect, test } from "bun:test";
import { findLiveInstanceAt } from "../src/instance";

test("preferred-port fallback accepts only the RēDesign health identity", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/api/health"
        ? Response.json({ ok: true, service: "redesign" })
        : new Response(null, { status: 404 });
    },
  });
  try {
    expect(await findLiveInstanceAt(`http://127.0.0.1:${server.port}`, 500)).toEqual({
      url: `http://127.0.0.1:${server.port}`,
    });
  } finally {
    server.stop(true);
  }
});

test("preferred-port fallback rejects another service", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, service: "other" }) });
  try {
    expect(await findLiveInstanceAt(`http://127.0.0.1:${server.port}`, 500)).toBeNull();
  } finally {
    server.stop(true);
  }
});

// Coverage for the queue's release gate (src/http/runQueue.ts).
//
// The control panel's two buttons map onto two server behaviours: POST /api/run with
// `autoStart: false` parks a run, and POST /api/queue/start releases what is parked.
// Everything else — the MCP tools, the CLI — omits the flag and must keep the original
// submit-and-run behaviour. Those are the invariants worth pinning down, because a
// regression in either direction is expensive: a parked run that starts anyway spends
// keys the user never authorised, and a released run that stays parked looks like a hang.
//
// Runs here are `mock: true`, so they complete offline in milliseconds and spend nothing.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { createApp } from "../src/http/app";
import * as store from "../src/store";
import * as inputResolver from "../src/inputResolver";

describe("run queue: the release gate", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const createdRunIds: string[] = [];

  beforeAll(() => {
    const app = createApp();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    for (const runId of createdRunIds) {
      try {
        fs.rmSync(store.runDir(runId), { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  });

  // The same-origin guard (src/http/origin-guard.ts) rejects a POST without a matching
  // Origin, so every request here carries one exactly as the browser would.
  async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  const inputs = inputResolver.listInputs();
  const firstInput = inputs[0];
  // Every assertion below needs at least one real input to fan out over; without one
  // the runner has nothing to queue and the test would assert on an empty run.
  const maybeIt = firstInput ? it : it.skip;

  async function queueRun(label: string, over: Record<string, unknown> = {}): Promise<string> {
    const body = {
      label,
      mock: true,
      inputs: { ids: [firstInput?.id] },
      models: { ids: ["gemini-3.5-flash"] },
      prompts: { presets: ["faithful-refresh"] },
      autoStart: false,
      ...over,
    };
    const { runId } = (await post("/api/run", body)) as { runId: string };
    createdRunIds.push(runId);
    return runId;
  }

  async function manifestOf(runId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Poll until `runId` leaves queued/running, or give up. Mock runs finish fast. */
  async function settle(runId: string, tries = 60): Promise<string> {
    let status = "";
    for (let i = 0; i < tries; i++) {
      status = String((await manifestOf(runId)).status);
      if (status !== "queued" && status !== "running") return status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return status;
  }

  maybeIt("parks an autoStart:false run instead of running it", async () => {
    const runId = await queueRun("gate-parked");

    // Give the runner a generous window to misbehave. A mock run that was going to
    // start would have finished several times over in this long.
    await new Promise((r) => setTimeout(r, 600));

    const manifest = await manifestOf(runId);
    expect(manifest.status).toBe("queued");
    expect((manifest.queue as { held?: boolean } | null)?.held).toBe(true);
    // Nothing generated: a run that had started would have jobs recorded against it.
    expect((manifest.counts as { done?: number } | undefined)?.done ?? 0).toBe(0);
  });

  maybeIt("runs a parked run once the queue is started, and reports how many it released", async () => {
    const runId = await queueRun("gate-released");
    const before = await manifestOf(runId);
    expect(before.status).toBe("queued");

    const result = (await post("/api/queue/start")) as { started: number; held: number };
    expect(result.started).toBeGreaterThanOrEqual(1);

    expect(await settle(runId)).toBe("done");
    const after = await manifestOf(runId);
    expect((after.counts as { done?: number } | undefined)?.done).toBeGreaterThan(0);
  });

  // The compatibility guarantee: the MCP tools and the CLI never send the flag, and a
  // queue gate that silently parked their runs would hang every agent-driven batch.
  maybeIt("still auto-runs a submission that omits autoStart", async () => {
    const runId = await queueRun("gate-legacy", { autoStart: undefined });

    expect(await settle(runId)).toBe("done");
    // It was never held, so it must not have been waiting on a release.
    const manifest = await manifestOf(runId);
    expect((manifest.queue as { held?: boolean } | null)?.held).toBeFalsy();
  });

  maybeIt("releases only what was already queued, so a later add stays parked", async () => {
    const first = await queueRun("gate-snapshot-1");
    await post("/api/queue/start");
    expect(await settle(first)).toBe("done");

    // Added *after* the release: the snapshot semantics mean this one needs its own press.
    const second = await queueRun("gate-snapshot-2");
    await new Promise((r) => setTimeout(r, 600));
    expect((await manifestOf(second)).status).toBe("queued");

    await post("/api/queue/start");
    expect(await settle(second)).toBe("done");
  });

  maybeIt("reports zero released when nothing is parked, rather than failing", async () => {
    const result = (await post("/api/queue/start")) as { started: number; held: number };
    expect(result.started).toBe(0);
    expect(result.held).toBe(0);
  });

  maybeIt("keeps submission order when several parked runs are released together", async () => {
    const a = await queueRun("gate-order-a");
    const b = await queueRun("gate-order-b");

    const positions = [
      (await manifestOf(a)).queue as { position?: number },
      (await manifestOf(b)).queue as { position?: number },
    ];
    expect(positions[0]?.position).toBeLessThan(positions[1]?.position ?? 0);

    const result = (await post("/api/queue/start")) as { started: number };
    expect(result.started).toBe(2);

    expect(await settle(a)).toBe("done");
    expect(await settle(b)).toBe("done");
  });

  maybeIt("drops a cancelled parked run without blocking the one behind it", async () => {
    const doomed = await queueRun("gate-cancelled");
    const survivor = await queueRun("gate-survivor");

    await post(`/api/runs/${encodeURIComponent(doomed)}/cancel`);
    expect(String((await manifestOf(doomed)).status)).toBe("cancelled");

    await post("/api/queue/start");
    expect(await settle(survivor)).toBe("done");
  });

  // Drag-to-reorder the parked queue: the requested order is honoured for the runs named, and
  // each run's manifest position updates to match, so the client's position-sorted queue strip
  // shows the new order. Held runs stay held — reorder only changes the order they'll run in.
  maybeIt("reorders the parked queue to the requested order and renumbers positions", async () => {
    const a = await queueRun("reorder-a");
    const b = await queueRun("reorder-b");
    const c = await queueRun("reorder-c");

    const result = (await post("/api/queue/reorder", { order: [c, a, b] })) as { order: string[] };
    const rank = (id: string) => result.order.indexOf(id);
    expect(rank(c)).toBeGreaterThanOrEqual(0);
    expect(rank(c)).toBeLessThan(rank(a));
    expect(rank(a)).toBeLessThan(rank(b));

    const posOf = async (id: string) => ((await manifestOf(id)).queue as { position?: number }).position ?? 0;
    const [pc, pa, pb] = [await posOf(c), await posOf(a), await posOf(b)];
    expect(pc).toBeLessThan(pa);
    expect(pa).toBeLessThan(pb);

    // All three are still parked — reordering must never release a run.
    for (const id of [a, b, c]) expect(String((await manifestOf(id)).status)).toBe("queued");
    for (const id of [a, b, c]) {
      expect(((await manifestOf(id)).queue as { held?: boolean }).held).toBe(true);
    }
  });

  // A partial/stale order from the client must not drop the runs it left out.
  maybeIt("keeps queued runs that the requested order omits", async () => {
    const x = await queueRun("reorder-keep-x");
    const y = await queueRun("reorder-keep-y");

    const result = (await post("/api/queue/reorder", { order: [y] })) as { order: string[] };
    expect(result.order).toContain(x);
    expect(result.order).toContain(y);
  });
});

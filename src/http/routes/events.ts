/**
 * GET /api/events — daemon-wide Server-Sent Events (src/bus.ts). The counterpart to
 * GET /api/runs/:id/events (routes/runs.ts) for signals that aren't scoped to one run: today the
 * only publisher is src/auto-update.ts's notify path ("update_available"), which has to reach the
 * UI even when nothing is running. Same contract as the per-run stream: `retry: 3000` first, then
 * a 25s `: ping` heartbeat so a reverse proxy doesn't time the connection out while it's idle.
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../deps";
import { addListener, removeListener, type BusListener } from "../../bus";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.write("retry: 3000\n\n");
      const listener: BusListener = (payload) => {
        stream.write(`data: ${payload}\n\n`).catch(() => {
          /* client gone; removeListener on abort below cleans this up */
        });
      };
      addListener(listener);
      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {});
      }, 25000);
      heartbeat.unref?.();
      stream.onAbort(() => {
        clearInterval(heartbeat);
        removeListener(listener);
      });
      // Keep the handler alive until the client disconnects; broadcast() (src/bus.ts) writes to
      // `stream` from the outside via the listener above for the lifetime of this connection.
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });
}

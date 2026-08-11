/**
 * Daemon-wide pub/sub for server -> browser push that isn't scoped to one run — the counterpart
 * to src/http/runQueue.ts's per-run SSE broadcast(), which only reaches clients subscribed to
 * that specific runId. Nothing needed a channel wider than a run until src/auto-update.ts's
 * notify path: "an update is available" has to reach the UI even when nothing is running, so it
 * can't ride the per-run stream. Kept in its own module (no imports of app internals) so nothing
 * that wants to broadcast — or subscribe, see src/http/routes/events.ts — creates an import cycle.
 *
 * Payloads are pre-serialized once in broadcast() and handed to every subscriber as a JSON string
 * carrying a `type` field, mirroring the shape GET /api/runs/:id/events already sends (see
 * src/web/src/stores/viewer.ts's RunEvent): one generic SSE `data:` line per message, no named
 * SSE `event:` lines, so a client's `onmessage` handler can inspect `type` the same way either
 * channel already expects.
 */
export type BusListener = (payload: string) => void;

const listeners = new Set<BusListener>();

export function addListener(l: BusListener): void {
  listeners.add(l);
}

export function removeListener(l: BusListener): void {
  listeners.delete(l);
}

/** Serialize once (`{ type, ...data }`) and hand the payload to every subscriber. */
export function broadcast(type: string, data: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({ type, ...data });
  for (const l of listeners) {
    // Isolate subscribers: one throwing listener must not drop the event for the others.
    try {
      l(payload);
    } catch {
      /* a bad subscriber is its own problem; keep delivering to the rest */
    }
  }
}

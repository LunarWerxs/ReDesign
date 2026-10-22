import type { Hono } from "hono";
import type { Deps } from "../deps";
import * as store from "../../store";
import { requireSameOrigin } from "../origin-guard";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/runs/:id/review", (c) => {
    const id = c.req.param("id");
    try {
      if (!store.readManifest(id)) return c.json({ error: "run not found" }, 404);
      return c.json(store.getReview(id));
    } catch { return c.json({ error: "invalid run id" }, 400); }
  });
  app.put("/api/runs/:id/review", requireSameOrigin(), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid review" }, 400);
    try { return c.json(store.saveReview(id, body as Partial<store.RunReview>, store.readManifest(id))); }
    catch (err) { return c.json({ error: err instanceof Error ? err.message : "invalid run id" }, (err as { status?: number }).status === 404 ? 404 : 400); }
  });
}

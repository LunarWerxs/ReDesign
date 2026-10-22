// Arena routes: the owner's pairwise "which output is better" votes and the per-model Elo board
// they produce (src/arena.ts). Validation errors throw a {status}-carrying Error that
// app.onError turns into JSON, like the models/prompts routes.
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { arenaBoard, recordArenaVote, undoLastArenaVote } from "../../arena";
import { requireSameOrigin } from "../origin-guard";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/arena", (c) => c.json(arenaBoard()));
  app.post("/api/arena/votes", requireSameOrigin(), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid vote" }, 400);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return c.json(recordArenaVote(str(body.runId), str(body.winnerJobId), str(body.loserJobId)));
  });
  app.delete("/api/arena/votes/last", requireSameOrigin(), (c) => c.json(undoLastArenaVote()));
}

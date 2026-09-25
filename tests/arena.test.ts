// Arena votes (src/arena.ts, src/http/routes/arena.ts): pairwise A/B picks folded into a per-model
// Elo board. Pins two contracts: the rating math ranks a repeat winner above its loser without
// minting points, and the vote route credits the models the RUN'S MANIFEST says produced each job
// (never ids the client sends), refusing pairs that say nothing about models.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { ARENA_BASE_RATING, rankModels, type ArenaBoard, type ArenaVote } from "../src/arena";
import { ARENA_VOTES_FILE } from "../src/config/shared";
import { createApp } from "../src/http/app";
import * as store from "../src/store";
import type { Manifest } from "../src/store";

const vote = (winner: string, loser: string): ArenaVote => ({
  at: "2099-01-01T00:00:00.000Z",
  runId: "r",
  winnerJobId: `${winner}-job`,
  loserJobId: `${loser}-job`,
  winnerModelId: winner,
  loserModelId: loser,
  winnerLabel: winner.toUpperCase(),
  loserLabel: loser.toUpperCase(),
});

describe("arena: Elo ranking", () => {
  it("ranks a repeat winner above its loser, zero-sum around the base rating", () => {
    const board = rankModels([vote("a", "b"), vote("a", "b"), vote("c", "b")]);
    expect(board.map((s) => s.modelId)).toEqual(["a", "c", "b"]);
    const [a, , b] = board;
    expect(a!.rating).toBeGreaterThan(ARENA_BASE_RATING);
    expect(b!.rating).toBeLessThan(ARENA_BASE_RATING);
    expect(a!.wins).toBe(2);
    expect(b!.losses).toBe(3);
    const total = board.reduce((sum, s) => sum + s.rating, 0);
    expect(Math.abs(total - ARENA_BASE_RATING * board.length)).toBeLessThanOrEqual(2); // rounding only
  });

  it("an upset over a stronger model moves the score more than beating an equal", () => {
    const upset = rankModels([vote("a", "b"), vote("a", "b"), vote("a", "b"), vote("a", "b"), vote("c", "a")]).find((s) => s.modelId === "c")!;
    const even = rankModels([vote("c", "d")]).find((s) => s.modelId === "c")!;
    expect(upset.rating).toBeGreaterThan(even.rating);
  });
});

describe("arena: vote routes", () => {
  const app = createApp();
  const headers = { "Content-Type": "application/json", Origin: "http://localhost" };
  const runId = `20990101-000000-arena-${process.pid}`;
  const mockRunId = `20990101-000001-arena-mock-${process.pid}`;
  const job = (id: string, modelId: string, inputId = "in") => ({ id, inputId, modelId, promptId: "p", variant: 1, status: "ok", file: `${id}.html` });
  const manifest = (id: string, mock: boolean) =>
    ({
      runId: id,
      status: "ok",
      finishedAt: "2099-01-01T00:00:00.000Z",
      mock,
      inputs: [],
      prompts: [],
      models: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }],
      jobs: [job("j1", "alpha"), job("j2", "beta"), job("j3", "alpha"), job("j4", "beta", "other")],
    }) as unknown as Manifest;
  const post = (body: unknown) => app.request("http://localhost/api/arena/votes", { method: "POST", headers, body: JSON.stringify(body) });

  beforeAll(() => {
    fs.rmSync(ARENA_VOTES_FILE, { force: true });
    store.writeManifest(runId, manifest(runId, false));
    store.writeManifest(mockRunId, manifest(mockRunId, true));
  });
  afterAll(() => {
    fs.rmSync(ARENA_VOTES_FILE, { force: true });
    for (const id of [runId, mockRunId]) fs.rmSync(store.runDir(id), { recursive: true, force: true });
  });

  it("credits the manifest's models, not client-sent ids, and undo removes the vote", async () => {
    const res = await post({ runId, winnerJobId: "j2", loserJobId: "j1", winnerModelId: "alpha" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArenaBoard & { vote: ArenaVote };
    expect(body.vote.winnerModelId).toBe("beta");
    expect(body.vote.loserModelId).toBe("alpha");
    expect(body.standings[0]).toMatchObject({ modelId: "beta", label: "Beta", wins: 1, losses: 0 });

    const board = (await (await app.request("http://localhost/api/arena")).json()) as ArenaBoard;
    expect(board.votes).toBe(1);

    const undone = await app.request("http://localhost/api/arena/votes/last", { method: "DELETE", headers });
    expect(((await undone.json()) as ArenaBoard).votes).toBe(0);
  });

  it("refuses pairs that say nothing about models", async () => {
    expect((await post({ runId, winnerJobId: "j1", loserJobId: "j3" })).status).toBe(400); // same model
    expect((await post({ runId, winnerJobId: "j1", loserJobId: "j4" })).status).toBe(400); // different inputs
    expect((await post({ runId, winnerJobId: "j1", loserJobId: "nope" })).status).toBe(400); // unknown job
    expect((await post({ runId: mockRunId, winnerJobId: "j2", loserJobId: "j1" })).status).toBe(400); // mock placeholders
    expect((await post({ runId: `20990101-000002-missing-${process.pid}`, winnerJobId: "j2", loserJobId: "j1" })).status).toBe(404);
    expect(((await (await app.request("http://localhost/api/arena")).json()) as ArenaBoard).votes).toBe(0);
  });
});

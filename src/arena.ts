/**
 * Arena-style pairwise model ranking.
 *
 * WHY: a run fans one screenshot out to a stack of models, but nothing remembered which model
 * the owner keeps preferring. The viewer's A/B duel shows two outputs of the SAME input from two
 * DIFFERENT models, the owner picks the better one, and each pick is appended here. Replaying the
 * votes in order through a plain Elo update (the scheme Chatbot Arena popularised for ranking
 * LLMs from anonymous side-by-side human votes) gives a per-model score the control panel can use
 * to pick the default model stack and drop models that never win.
 *
 * Votes live in <config>/arena-votes.json (user data, never seeded, never synced). Model ids are
 * resolved from the run's own manifest, never trusted from the client, so a stale tab cannot
 * credit the wrong model.
 */
import { ARENA_VOTES_FILE, withConfigLock } from "./config/shared";
import { readJSON, writeJSON } from "./util";
import { readManifest } from "./store";
import { statusError } from "./store/types";

export interface ArenaVote {
  at: string;
  runId: string;
  winnerJobId: string;
  loserJobId: string;
  winnerModelId: string;
  loserModelId: string;
  winnerLabel: string;
  loserLabel: string;
}

export interface ArenaStanding {
  modelId: string;
  label: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
}

export interface ArenaBoard {
  votes: number;
  standings: ArenaStanding[];
}

export const ARENA_BASE_RATING = 1500;
export const ARENA_K = 32;
// Oldest votes roll off past this, so the file stays small and the board tracks recent taste.
const MAX_VOTES = 5000;

interface ArenaFile {
  version: 1;
  votes: ArenaVote[];
}

function isVote(v: unknown): v is ArenaVote {
  const o = v as Partial<ArenaVote> | null;
  return !!o && typeof o.winnerModelId === "string" && typeof o.loserModelId === "string" && !!o.winnerModelId && !!o.loserModelId;
}

export function readArenaVotes(): ArenaVote[] {
  const raw = readJSON<Partial<ArenaFile> | null>(ARENA_VOTES_FILE, null);
  return Array.isArray(raw?.votes) ? raw.votes.filter(isVote) : [];
}

function writeArenaVotes(votes: ArenaVote[]): void {
  const file: ArenaFile = { version: 1, votes: votes.slice(-MAX_VOTES) };
  writeJSON(ARENA_VOTES_FILE, file);
}

/**
 * Replay votes oldest-first through a sequential Elo update. Every model starts at the base
 * rating; a win against a stronger model moves the score more than a win against a weaker one.
 * Sorted best-first; ties break on more games, then id, so the order is stable.
 */
export function rankModels(votes: readonly ArenaVote[]): ArenaStanding[] {
  const rows = new Map<string, { label: string; rating: number; wins: number; losses: number }>();
  const row = (id: string, label: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { label: label || id, rating: ARENA_BASE_RATING, wins: 0, losses: 0 };
      rows.set(id, r);
    } else if (label) r.label = label; // newest label wins after a rename
    return r;
  };
  for (const v of votes) {
    if (v.winnerModelId === v.loserModelId) continue;
    const w = row(v.winnerModelId, v.winnerLabel);
    const l = row(v.loserModelId, v.loserLabel);
    const expectedWin = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
    const delta = ARENA_K * (1 - expectedWin);
    w.rating += delta;
    l.rating -= delta;
    w.wins += 1;
    l.losses += 1;
  }
  return [...rows.entries()]
    .map(([modelId, r]) => ({
      modelId,
      label: r.label,
      rating: Math.round(r.rating),
      wins: r.wins,
      losses: r.losses,
      games: r.wins + r.losses,
    }))
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.modelId.localeCompare(b.modelId));
}

export function arenaBoard(votes: readonly ArenaVote[] = readArenaVotes()): ArenaBoard {
  return { votes: votes.length, standings: rankModels(votes) };
}

/**
 * Record "winnerJobId beat loserJobId" for one run. Both jobs must be finished outputs of the
 * same input from different models, in a real (non-mock) run; anything else is a 400/404.
 */
export function recordArenaVote(runId: string, winnerJobId: string, loserJobId: string): { vote: ArenaVote } & ArenaBoard {
  if (!runId || !winnerJobId || !loserJobId) throw statusError("runId, winnerJobId and loserJobId are required", 400);
  if (winnerJobId === loserJobId) throw statusError("a vote needs two different outputs", 400);
  let manifest: ReturnType<typeof readManifest>;
  try { manifest = readManifest(runId); } catch { throw statusError("invalid run id", 400); }
  if (!manifest) throw statusError("run not found", 404);
  if (manifest.mock === true) throw statusError("mock runs are placeholders and cannot be voted on", 400);
  const jobs = manifest.jobs || [];
  const winner = jobs.find((j) => j.id === winnerJobId);
  const loser = jobs.find((j) => j.id === loserJobId);
  if (!winner || !loser) throw statusError("unknown job id for this run", 400);
  if (winner.status !== "ok" || loser.status !== "ok") throw statusError("only finished outputs can be compared", 400);
  const winnerModelId = String(winner.modelId || "");
  const loserModelId = String(loser.modelId || "");
  if (!winnerModelId || !loserModelId || winnerModelId === loserModelId) throw statusError("a vote compares two different models", 400);
  if (winner.inputId !== loser.inputId) throw statusError("a vote compares outputs of the same input", 400);
  const models = Array.isArray(manifest.models) ? (manifest.models as { id?: string; label?: string }[]) : [];
  const labelOf = (id: string) => models.find((m) => m.id === id)?.label || id;
  const vote: ArenaVote = {
    at: new Date().toISOString(),
    runId,
    winnerJobId,
    loserJobId,
    winnerModelId,
    loserModelId,
    winnerLabel: labelOf(winnerModelId),
    loserLabel: labelOf(loserModelId),
  };
  return withConfigLock(() => {
    const votes = [...readArenaVotes(), vote];
    writeArenaVotes(votes);
    return { vote, ...arenaBoard(votes) };
  });
}

/** Drop the newest vote (the viewer's "undo"); a no-op returning removed:null when empty. */
export function undoLastArenaVote(): { removed: ArenaVote | null } & ArenaBoard {
  return withConfigLock(() => {
    const votes = readArenaVotes();
    const removed = votes.pop() ?? null;
    if (removed) writeArenaVotes(votes);
    return { removed, ...arenaBoard(votes) };
  });
}

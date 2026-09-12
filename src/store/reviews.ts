/** Durable, per-run reviewer choices. Kept beside the immutable manifest so moving a run also
 * moves its shortlist, notes, and retention protection. */
import path from "node:path";
import { readJSON, writeJSON } from "../util";
import { manifestPath, runDir } from "./paths";
import type { Manifest } from "./types";

export interface RunReview {
  shortlist: string[];
  hidden: string[];
  notes: Record<string, string>;
  keep: boolean;
  updatedAt: string | null;
}

const EMPTY_REVIEW: RunReview = { shortlist: [], hidden: [], notes: {}, keep: false, updatedAt: null };
function reviewPath(runId: string): string { return path.join(runDir(runId), "review.json"); }

function getReview(runId: string): RunReview {
  const raw = readJSON<Partial<RunReview> | null>(reviewPath(runId), null);
  if (!raw) return { ...EMPTY_REVIEW, notes: {} };
  const shortlist = Array.isArray(raw.shortlist) ? [...new Set(raw.shortlist.map(String).filter(Boolean))] : [];
  const notes: Record<string, string> = {};
  if (raw.notes && typeof raw.notes === "object") {
    for (const [key, value] of Object.entries(raw.notes)) if (typeof value === "string" && value.trim()) notes[key] = value.slice(0, 10_000);
  }
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.map(String).filter(Boolean))] : [];
  return { shortlist, hidden, notes, keep: raw.keep === true, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
}

function saveReview(runId: string, update: Partial<RunReview>, manifest?: Manifest | null): RunReview {
  // A route may pass the manifest it just read; keeping this fallback also makes the store API
  // safe for CLI callers. Unknown job ids are discarded so a stale browser cannot pin ghosts.
  const m = manifest ?? readJSON<Manifest | null>(manifestPath(runId), null);
  if (!m) throw Object.assign(new Error("run not found"), { status: 404 });
  const valid = new Set((m.jobs || []).map((j) => String(j.id || "")).filter(Boolean));
  const previous = getReview(runId);
  const shortlist = Array.isArray(update.shortlist) ? [...new Set(update.shortlist.map(String).filter((id) => valid.has(id)))] : previous.shortlist.filter((id) => valid.has(id));
  const hidden = Array.isArray(update.hidden) ? [...new Set(update.hidden.map(String).filter((id) => valid.has(id)))] : previous.hidden.filter((id) => valid.has(id));
  const sourceNotes = update.notes && typeof update.notes === "object" ? update.notes : previous.notes;
  const notes: Record<string, string> = {};
  for (const [id, note] of Object.entries(sourceNotes)) if (valid.has(id) && typeof note === "string" && note.trim()) notes[id] = note.slice(0, 10_000);
  const next: RunReview = { shortlist, hidden, notes, keep: update.keep === undefined ? previous.keep : update.keep === true, updatedAt: new Date().toISOString() };
  writeJSON(reviewPath(runId), next);
  return next;
}

export { getReview, saveReview, reviewPath };

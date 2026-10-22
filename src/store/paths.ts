/**
 * Where a run lives on disk and what it is called. Every manifest read and write in the
 * store funnels through runDir()/manifestPath(), which is what makes resolveRunDir() the
 * single place path traversal has to be rejected.
 */
import path from "node:path";
import { ROOT, slugify, resolveInside } from "../util";
import { statusError } from "./types";

const OUTPUT_DIR = path.join(ROOT, "output");

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Monotonic per-process counter guarantees uniqueness even within the same ms.
let _seq = 0;

// Human-readable, sortable, collision-resistant run id:
//   20260608-174939-<hrtime><seq>[-label]
function newRunId(label?: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
  const ent = (process.hrtime.bigint() % 2176782336n).toString(36).padStart(6, "0"); // 6 base36 chars
  const seq = (_seq++).toString(36);
  const suffix = label ? `-${slugify(label).slice(0, 20)}` : "";
  return `${stamp}-${ent}${seq}${suffix}`;
}

// runDir/manifestPath are the single choke point every manifest read and write
// flows through, so they must validate the id here — otherwise a caller with an
// untrusted id (the GET /api/runs/:id and /events routes pass the raw route param)
// could escape OUTPUT_DIR via path traversal. resolveRunDir() rejects any id with
// a path separator, "."/".." or that resolves outside OUTPUT_DIR (400).
function runDir(runId: string): string {
  return resolveRunDir(runId);
}

function manifestPath(runId: string): string {
  return path.join(runDir(runId), "manifest.json");
}

function resolveRunDir(runId: unknown): string {
  const id = String(runId || "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw statusError("invalid run id", 400);
  }
  try {
    return resolveInside(OUTPUT_DIR, id, { allowBaseItself: false, decode: false }).full;
  } catch (_) {
    throw statusError("invalid run id", 400);
  }
}

export { OUTPUT_DIR, newRunId, runDir, manifestPath, resolveRunDir };

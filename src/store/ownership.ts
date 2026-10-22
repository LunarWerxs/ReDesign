/**
 * A short, private lease for the process currently advancing a run.  The lease lives next to
 * manifest.json but starts with a dot, keeping operational state out of output serving/exports.
 * Creation uses O_EXCL; readers only ever inspect it, while a claimant quarantines a proven-dead
 * lease before retrying.  That prevents a competing reclaimer from deleting a successor's lease.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../util";
import { runDir } from "./paths";
import type { RunOwnership, RunOwnershipClaim } from "./types";
import { statusError } from "./types";

const OWNER_FILE = ".owner.json";
const HEARTBEAT_MS = 5_000;

function ownerPath(runId: string): string {
  return path.join(runDir(runId), OWNER_FILE);
}

function readOwner(file: string): RunOwnership | null {
  try {
    const candidate = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunOwnership>;
    if (
      !Number.isInteger(candidate.pid) ||
      (candidate.pid as number) <= 0 ||
      typeof candidate.token !== "string" ||
      !candidate.token ||
      !Number.isFinite(Date.parse(String(candidate.createdAt))) ||
      !Number.isFinite(Date.parse(String(candidate.heartbeatAt)))
    ) return null;
    return candidate as RunOwnership;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the OS found the process but this user cannot signal it.
    return !!(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function ownerIsLive(owner: RunOwnership): boolean {
  // The heartbeat tells observers that the owner is making progress, but it is not a lease
  // expiry. A busy CLI or a paused daemon can miss ticks; a live PID must stay protected rather
  // than letting another process settle or delete its work. The UUID token still prevents a
  // release from deleting a later owner's record.
  return processIsAlive(owner.pid);
}

/** True only for a current process lease. This check never changes the filesystem. */
function isRunOwned(runId: string): boolean {
  const file = ownerPath(runId);
  const owner = readOwner(file);
  // A partially written or malformed owner record is conservatively considered occupied. It must
  // never cause a reader to settle work that another process could still be writing.
  return owner ? ownerIsLive(owner) : fs.existsSync(file);
}

function writeNewOwner(file: string, owner: RunOwnership): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner));
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function quarantineDeadOwner(file: string, owner: RunOwnership): boolean {
  // rename is atomic. A simultaneous reclaimer can only move one copy; neither can remove a
  // successor created after the old file is moved out of the way.
  const quarantine = `${file}.${owner.token}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(file, quarantine);
  } catch {
    return false;
  }
  try {
    fs.rmSync(quarantine, { force: true });
  } catch {
    /* Best effort: it is private debris and cannot affect the active owner path. */
  }
  return true;
}

/**
 * Claim a per-run lease. Collisions are reported as HTTP-style 409 errors so the HTTP, CLI, and
 * daemon callers can share the same admission result. The heartbeat timer is unref'ed and is
 * always cleared by release(), so a finished run cannot keep the process alive.
 */
function claimRunOwnership(runId: string): RunOwnershipClaim {
  const file = ownerPath(runId);
  ensureDir(runDir(runId));
  const owner: RunOwnership = {
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  for (;;) {
    if (writeNewOwner(file, owner)) break;
    const previous = readOwner(file);
    if (!previous || ownerIsLive(previous)) throw statusError("run is already owned", 409);
    quarantineDeadOwner(file, previous);
  }

  let released = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const update = () => {
    if (released) return;
    const current = readOwner(file);
    if (!current || current.token !== owner.token) return;
    owner.heartbeatAt = new Date().toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
    } catch {
      // A failed heartbeat must not erase a successor or throw from a timer callback.
    }
  };
  timer = setInterval(update, HEARTBEAT_MS);
  timer.unref?.();

  return {
    owner: { ...owner },
    update,
    release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        if (readOwner(file)?.token === owner.token) fs.unlinkSync(file);
      } catch {
        /* A missing/replaced lease is already safely released from this claimant's perspective. */
      }
    },
  };
}

export { claimRunOwnership, isRunOwned, OWNER_FILE, ownerPath };

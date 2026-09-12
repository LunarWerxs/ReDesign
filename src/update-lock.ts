/**
 * Per-install update transaction lock. This is deliberately app-local: the shared updater
 * engine has no knowledge of compiled-install staging or this app's service identity.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = ".redesign-update.lock";
const STAGING_NAME = ".update-staging";
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

export interface UpdateLock {
  release(): void;
}

function lockPath(installDir: string): string {
  return join(installDir, LOCK_NAME);
}

function ownerIsAlive(lockFile: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown };
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeAbandonedLock(lockFile: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown };
    const pid = Number(owner.pid);
    if (Number.isInteger(pid) && pid > 0 && !ownerIsAlive(lockFile)) {
      unlinkSync(lockFile);
      return true;
    }
    const age = Date.now() - statSync(lockFile).mtimeMs;
    if (age < ABANDONED_AFTER_MS || ownerIsAlive(lockFile)) return false;
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/** Acquire without waiting. A busy update remains the owner of all staging artifacts. */
export function acquireUpdateLock(installDir: string): UpdateLock | null {
  const file = lockPath(installDir);
  try {
    mkdirSync(installDir, { recursive: true });
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) return null;
    if (!removeAbandonedLock(file)) return null;
    return acquireUpdateLock(installDir);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        // Do not remove a successor's lock if a filesystem race replaced ours.
        const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
        if (owner.pid === process.pid) unlinkSync(file);
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Startup cleanup only proceeds when it owns the transaction lock. That means a second launcher
 * cannot erase another process's staging directory or rollback binary before it discovers the
 * already-running daemon.
 */
export function cleanupUpdateArtifacts(installDir: string, executableName: string): void {
  const lock = acquireUpdateLock(installDir);
  if (!lock) return;
  try {
    const staging = join(installDir, STAGING_NAME);
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // Keep recent rollback binaries: an interrupted handoff can still need them. An old binary
    // is recoverable only through a completed/abandoned transaction, and the lock proves no
    // updater is currently using it.
    for (const name of readdirSync(installDir)) {
      if (!name.startsWith(`${executableName}.old-`)) continue;
      const candidate = join(installDir, name);
      try {
        if (Date.now() - statSync(candidate).mtimeMs >= ABANDONED_AFTER_MS) rmSync(candidate, { force: true });
      } catch {
        /* best effort */
      }
    }
  } finally {
    lock.release();
  }
}

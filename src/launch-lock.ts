/** A short-lived cross-process gate around the daemon liveness check and bind. */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = ".redesign-launch.lock";
const STALE_AFTER_MS = 30_000;

export interface LaunchLock {
  release(): void;
}

function processIsAlive(file: string): boolean {
  try {
    const pid = Number((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLaunchLock(configDir: string): LaunchLock | null {
  const file = join(configDir, LOCK_NAME);
  try {
    mkdirSync(configDir, { recursive: true });
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
  } catch (error: unknown) {
    const exists = !!(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
    if (!exists) return null;
    try {
      const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      const pid = Number(owner.pid);
      const deadOwner = Number.isInteger(pid) && pid > 0 && !processIsAlive(file);
      if (deadOwner || (Date.now() - statSync(file).mtimeMs >= STALE_AFTER_MS && !processIsAlive(file))) {
        unlinkSync(file);
      } else return null;
    } catch {
      return null;
    }
    return acquireLaunchLock(configDir);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        const owner = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
        if (owner.pid === process.pid) unlinkSync(file);
      } catch {
        /* best effort */
      }
    },
  };
}

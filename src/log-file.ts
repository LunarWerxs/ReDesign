/**
 * Persistent daemon log — tees console output to <CONFIG_DIR>/logs/daemon.log.
 *
 * Why this exists: the daemon is normally launched by the tray via `cmd.exe /c bun … ` with
 * CreateNoWindow, so its stdout/stderr go to a hidden console and are LOST. When the process
 * dies there is no record of WHY. This captures every console line to a file that survives the
 * process, regardless of how the daemon was launched (tray, terminal, or the auto-update
 * successor spawned by src/cli/lifecycle.ts's relaunch hook).
 *
 * Writes are SYNCHRONOUS (fs.writeSync on an appended fd), deliberately: a buffered stream
 * would lose the final console.error if the process exits a tick later. The daemon logs little
 * (a boot banner + occasional errors), so sync writes cost nothing here. Everything is
 * best-effort — a logging failure must never take the daemon down (that would be the ironic
 * opposite of the point), so every fs call is guarded and a hard failure just disables file
 * logging and leaves the real console untouched.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, rmSync } from "node:fs";
import { inspect } from "node:util";

// Same resolution as src/instance.ts's CONFIG_DIR, inlined so this module can run as the very
// first thing at startup without importing the instance/config chain. Keep in sync with
// instance.ts (REDESIGN_HOME override, trimmed, else ~/.redesign).
const defaultDir = (): string => process.env.REDESIGN_HOME?.trim() || join(homedir(), ".redesign");

/** Roll the log over at this size, keeping a single previous generation (bounds disk to ~2×). */
const MAX_BYTES = 5 * 1024 * 1024;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
const LEVEL: Record<ConsoleMethod, string> = {
  log: "INFO ",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  debug: "DEBUG",
};

let fd: number | null = null;
let patched = false;
const original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
let currentPath: string | null = null;

/** Format one console line the way console.* would render it (Errors keep their stack). */
function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" ");
}

function writeLine(level: string, text: string): void {
  if (fd === null) return;
  try {
    const stamp = new Date().toISOString();
    writeSync(fd, `[${stamp}] ${level} ${text}\n`);
  } catch {
    // Disk full / handle lost — stop trying so we don't spin on every log call. The real
    // console is untouched, so output still goes to stdout; only the file copy is dropped.
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already gone */
    }
    fd = null;
  }
}

/**
 * Open (or reopen) the daemon log and tee every console.* call to it. Idempotent — calling
 * twice is a no-op after the first success. Returns the log-file path, or null if file logging
 * could not be set up (in which case the console behaves exactly as before).
 *
 * @param opts.dir  Override the log directory (tests pass a temp dir).
 */
export function initFileLogging(opts?: { dir?: string }): string | null {
  if (patched && fd !== null) return currentPath;

  const dir = join(opts?.dir ?? defaultDir(), "logs");
  const path = join(dir, "daemon.log");
  try {
    mkdirSync(dir, { recursive: true });
    // Rotate before opening so a run's own crash still lands in the fresh file, and the
    // rotated copy holds the previous run(s). One generation only — daemon.log.1.
    try {
      if (statSync(path).size > MAX_BYTES) {
        const rolled = `${path}.1`;
        try {
          rmSync(rolled, { force: true });
        } catch {
          /* no previous generation */
        }
        renameSync(path, rolled);
      }
    } catch {
      /* no existing log yet, or stat/rename raced — just open fresh */
    }
    fd = openSync(path, "a");
    currentPath = path;
  } catch {
    fd = null;
    currentPath = null;
    return null; // logging dir unwritable — leave the console as-is
  }

  if (!patched) {
    for (const m of CONSOLE_METHODS) {
      const orig = console[m].bind(console) as (...args: unknown[]) => void;
      original[m] = orig;
      console[m] = (...args: unknown[]): void => {
        orig(...args); // real stdout/stderr, unchanged
        writeLine(LEVEL[m], formatArgs(args));
      };
    }
    patched = true;
  }

  // Boot marker so runs are visually separated across restarts sharing one file.
  writeLine("INFO ", `── daemon process ${process.pid} starting (${process.argv.slice(1).join(" ")}) ──`);
  return currentPath;
}

/** The current log-file path, or null if file logging isn't active. */
export function logFilePath(): string | null {
  return currentPath;
}

/** Undo the console patch and close the file. For tests; the daemon never calls this. */
export function restoreFileLogging(): void {
  for (const m of CONSOLE_METHODS) {
    const orig = original[m];
    if (orig) console[m] = orig as typeof console.log;
  }
  patched = false;
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = null;
  }
  currentPath = null;
}

/**
 * Daemon-lifecycle + read-only introspection CLI commands: `serve`/`start` (boot the web UI + API
 * in-process), `status`, `stop`, and the local inspection verbs (`inputs`, `models`, `prompts`,
 * `references`, `keys`, `health-check`) that read straight off disk/config without needing a
 * running server. Extracted verbatim (behavior-preserving) from the old src/cli.js so the CLI
 * entry (src/cli/main.ts) stays a thin dispatcher.
 */
import { spawn } from "node:child_process";
import { setAutoUpdateHooks, startAutoUpdate } from "../auto-update";
import { loadModels, loadPrompts, resolveModels } from "../config";
import { buildDetachedSpawn } from "../detached-spawn.mjs";
import { healthCheckModel } from "../healthCheck";
import { listInputs, listReferences } from "../inputResolver";
import { pingInstallOnBoot } from "../install-ping";
import { findLiveInstance } from "../instance";
import { openUi } from "../open-ui";
import { buildRelaunchArgv } from "../relaunch-argv.mjs";
import { getKeyManager } from "../runner";
import { cleanupStaleUpdateArtifacts } from "../updater";
import { C } from "../util";
import type { Args } from "./args";

// The PREFERRED base (mirrors http/serve.ts: HOST default 127.0.0.1, PORT default 5178; 0.0.0.0
// is a bind address, not a connect address, so fall back to loopback for the client). This is
// only a fallback now, the daemon may have hopped to a different port, resolveServerBase() below
// is what actually finds it.
function serverBase(): string {
  const host = process.env.HOST && process.env.HOST !== "0.0.0.0" ? process.env.HOST : "127.0.0.1";
  const port = process.env.PORT || 5178;
  return `http://${host}:${port}`;
}

// Resolve the live daemon's base URL: the instance pointer first (it knows where the daemon
// ACTUALLY bound, even after a port hop), falling back to probing the preferred port directly
// (covers REDESIGN_PORT_FIXED=1 and any daemon started before the pointer existed). Mirrors the
// CLI/tray resolution order documented in the sibling apps (RepoYeti's src/instance.ts).
async function resolveServerBase(): Promise<string> {
  const live = await findLiveInstance();
  if (live) return live.url;
  return serverBase();
}

interface ServerSummary {
  models: number;
  prompts: number;
  inputs: number;
  runs: number;
}

// Probe a running server (at `base`, or the resolved live URL if omitted) via GET /api/bootstrap;
// returns a small summary or null (not running).
async function probeServer(base?: string): Promise<ServerSummary | null> {
  try {
    const url = base ?? (await resolveServerBase());
    const res = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    const len = (x: unknown): number => (Array.isArray(x) ? x.length : 0);
    return { models: len(b.models), prompts: len(b.prompts), inputs: len(b.inputs), runs: len(b.runs) };
  } catch (_) {
    return null;
  }
}

export function inputsCmd(): void {
  const items = listInputs();
  if (!items.length) {
    console.log(C.yellow("No inputs found in input/."));
    return;
  }
  console.log(C.bold(`Inputs (${items.length}):`));
  for (const it of items) {
    console.log(
      `  ${C.cyan(it.id.padEnd(28))} ${it.type === "group" ? C.yellow("[group]") : "[image]"} ` +
        `${it.imageCount} img  ${C.dim(it.name)}`,
    );
  }
}

export function modelsCmd(): void {
  const models = loadModels();
  const km = getKeyManager();
  console.log(C.bold(`Models (${models.length}):`));
  for (const m of models) {
    const n = km.poolSize(m.keyEnv);
    const en = m.enabled === false ? C.red("disabled") : C.green("enabled");
    console.log(
      `  ${C.cyan(m.id.padEnd(18))} ${m.apiModel.padEnd(24)} ${String(n).padStart(2)} keys  ` +
        `${m.vision ? "vision" : "text  "}  ${en}  ${C.dim(m.provider)}`,
    );
  }
}

export function promptsCmd(): void {
  const { prompts } = loadPrompts();
  console.log(C.bold(`Default prompt presets (${prompts.length}):`));
  for (const p of prompts) console.log(`  ${C.cyan(p.id.padEnd(18))} ${C.dim(p.description || p.label)}`);
}

export function referencesCmd(): void {
  const refs = listReferences();
  if (!refs.length) {
    console.log(C.yellow("No reference images found in reference/."));
    return;
  }
  console.log(C.bold(`Reference images (${refs.length}):`));
  for (const r of refs) console.log(`  ${C.cyan(r.rel)}`);
}

export function keysCmd(args: Args): void {
  const km = getKeyManager();
  for (const m of loadModels()) km.registerPool(m.keyEnv);
  const snap = km.snapshot();
  if (args.json) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  console.log(C.bold("Key pools:"));
  for (const p of snap.pools) {
    console.log(
      `\n  ${C.cyan(p.pool)}  ${C.green(`${p.available} available`)} / ${p.total} total` +
        `  ${p.dead ? C.red(`${p.dead} dead`) : ""} ${p.noBalance ? C.yellow(`${p.noBalance} no-balance`) : ""} ${
          p.cooling ? C.dim(`${p.cooling} cooling`) : ""
        }`,
    );
    for (const e of p.entries) {
      const tag =
        e.status === "dead"
          ? C.red("dead    ")
          : e.status === "no_balance"
            ? C.yellow("nobalance")
            : !e.availableNow
              ? C.dim("cooldown")
              : e.status === "ok"
                ? C.green("ok      ")
                : C.dim("untested");
      console.log(
        `    ${e.mask.padEnd(16)} ${tag}  ✓${e.successes} ✗${e.failures}` +
          `${e.cooldownRemainingSec ? C.dim(`  ${e.cooldownRemainingSec}s`) : ""}` +
          `${e.lastError ? C.dim(`  ${e.lastError.slice(0, 60)}`) : ""}`,
      );
    }
  }
}

export async function healthCheckCmd(args: Args): Promise<void> {
  const models = resolveModels(typeof args.models === "string" ? args.models : "all");
  const km = getKeyManager();
  console.log(C.bold(`Live health check (spends a little quota) for ${models.length} model(s)...\n`));
  for (const m of models) {
    process.stdout.write(`  ${C.cyan(m.id.padEnd(18))} pinging ${km.poolSize(m.keyEnv)} keys... `);
    const r = await healthCheckModel(km, m, {});
    console.log(
      `${C.green(`${r.alive} alive`)} ${r.dead ? C.red(`${r.dead} dead`) : ""} ` +
        `${r.noBalance ? C.yellow(`${r.noBalance} no-balance`) : ""} ${r.throttled ? C.dim(`${r.throttled} throttled`) : ""}`,
    );
  }
  console.log(C.dim("\nState saved to src/keyState.json"));
}

export async function serveCmd(args: Args): Promise<void> {
  cleanupStaleUpdateArtifacts();
  // Anonymous install ping (see src/install-ping.ts): fire-and-forget, throttled to at most once
  // per 24h, opt out with REDESIGN_NO_PING=1. Never awaited — must never delay boot.
  pingInstallOnBoot();
  // Boot the web UI + API in-process, the same server as `npm start`, but reachable from the one
  // `redesign` command an agent already knows. --port/--host override (read by http/serve.ts at
  // load, so set them BEFORE importing it).
  if (args.port) process.env.PORT = String(args.port);
  if (args.host) process.env.HOST = String(args.host);
  // The auto-update successor is signalled BOTH by --relaunch and by REDESIGN_RELAUNCH=1. The flag
  // is the load-bearing half: the relaunch is handed to WMI Win32_Process.Create on win32 (see the
  // relaunch hook below), which takes a command LINE and does NOT inherit the caller's environment
  // block, so an env-only signal reaches the transient powershell.exe and never the successor
  // daemon. Set here, before the single-instance guard reads it and before http/serve.ts is
  // imported (it reads both PORT and REDESIGN_RELAUNCH at module load).
  if (args.relaunch) process.env.REDESIGN_RELAUNCH = "1";

  // Single-instance guard: if a RedDesign daemon is already serving (found via the runtime
  // pointer, or by probing the preferred port directly), don't start a second one, it would
  // just hop to another port and the CLI/tray would disagree about which instance is "the" one.
  // REDESIGN_PORT_FIXED=1 and REDESIGN_RELAUNCH=1 (the auto-update successor, which is SUPPOSED
  // to take over the same port from its predecessor) are exempt from this guard.
  if (process.env.REDESIGN_PORT_FIXED !== "1" && process.env.REDESIGN_RELAUNCH !== "1") {
    const live = await findLiveInstance();
    if (live) {
      console.log(C.yellow(`RēDesign is already running → ${live.url}`));
      if (args.openUi) openUi(live.url);
      return;
    }
  }
  const { startServer, shutdown } = await import("../http/serve");
  const server = await startServer();
  // Where we ACTUALLY landed — serve.ts may have hopped past a held port. Typed optional by
  // Bun.serve, so fall back to the same preference serve.ts itself computes.
  const boundPort = server.port ?? (Number.parseInt(process.env.PORT ?? "", 10) || 5178);
  if (args.openUi) {
    const url = `http://127.0.0.1:${boundPort}/`;
    if (!openUi(url)) console.error(C.yellow(`Could not open a browser automatically. Open ${url} manually.`));
  }

  // Auto-update loop (opt-in; see src/auto-update.ts). When it applies an update it must restart
  // the daemon ITSELF, RēDesign has no separate tray supervisor that relaunches us. So hand it a
  // relaunch that spawns a DETACHED copy of this exact launch command (REDESIGN_RELAUNCH=1 so the
  // successor's http/serve.ts bindWithRetry can tell this is an expected same-port handoff), then
  // gracefully shuts THIS daemon down (reusing serve.ts's own shutdown) to free the port.
  setAutoUpdateHooks({
    relaunch: () => {
      try {
        // process.execPath + the REAL args, never process.argv[0..1]. That pair is only the node
        // executable + script in a source checkout; inside a `bun build --compile` binary it is the
        // placeholder pair ["bun", "B:/~BUN/root/redesign.exe"] — argv[0] is the literal string
        // "bun" (not a path) and argv[1] is a virtual path that exists only inside the running
        // binary. Respawning it fails with `Module not found "B:/~BUN/root/redesign.exe"` where Bun
        // happens to be installed, and cannot resolve "bun" at all on the machines a compiled
        // release exists FOR. spawn() still resolves and returns a child (which then dies), so the
        // catch below never fires and we shut down 800ms later expecting a successor that is
        // already gone — an applied update leaving ZERO daemons.
        const isCompiled =
          (globalThis as { __REDESIGN_RELEASE_BUILD__?: boolean }).__REDESIGN_RELEASE_BUILD__ === true;
        const relaunchArgv = buildRelaunchArgv(process.argv, {
          execPath: process.execPath,
          isCompiled,
          boundPort,
          // `serve` is IMPLICIT on a double-clicked release build (main.ts falls back to it when
          // argv is empty). Appending flags to that empty list would put a flag in the command
          // slot and the successor would dispatch on "--relaunch" instead of serving.
          command: "serve",
        });
        // Through buildDetachedSpawn, not a plain spawn. `detached: true` is NOT a process-tree
        // escape on Windows — the shared primitive's own header says so, and that is why it
        // exists. Left as a plain spawn the successor stays inside THIS process's tree for the
        // whole ~800ms handoff, so a tray Quit (`taskkill /T /F`) landing in that window kills the
        // outgoing daemon AND its replacement, leaving the user with none.
        // hideWindow: the successor is a CONSOLE program - without ShowWindow=0 every auto-update relaunch pops a visible console hosting the daemon (kit fix 2026-08-30).
        const plan = buildDetachedSpawn(process.platform, relaunchArgv, { hideWindow: true });
        const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
          cwd: process.cwd(),
          detached: plan.detached,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            REDESIGN_RELAUNCH: "1",
            // The port we are actually SERVING on, not the one we preferred. serve.ts reads PORT
            // for its REDESIGN_RELAUNCH=1 branch, which binds it with NO findFreePort probe — so on
            // a daemon that hopped (foreign process on the preferred port), handing over the
            // preferred port aims the successor's bindWithRetry at a port nobody is releasing: it
            // retries, fails, and the update takes the daemon down for good. With the bound port it
            // rebinds the socket the predecessor is in the middle of freeing, which is exactly what
            // that branch was written to do, and the open tab's SSE reconnects instead of dying.
            PORT: String(boundPort),
          },
        });
        child.unref();
      } catch (e) {
        console.error(C.red("redesign: auto-update relaunch failed to spawn, staying on the running version."), e);
        return; // never shut down without a successor
      }
      console.log(C.dim("redesign: auto-update applied, relaunching the daemon..."));
      setTimeout(shutdown, 800); // let the successor start binding, then free the port
    },
  });
  startAutoUpdate();

  // The listening server keeps the event loop alive (foreground), nothing more to do here.
}

export async function statusCmd(args: Args): Promise<void> {
  const base = await resolveServerBase();
  const info = await probeServer(base);
  if (args.json) {
    console.log(JSON.stringify({ running: !!info, url: base, ...(info || {}) }, null, 2));
  } else if (info) {
    console.log(
      `${C.bold("RēDesign")}${C.green(" running")}${C.dim(` → ${base}`)}` +
        `\n  ${info.models} models · ${info.prompts} prompts · ${info.inputs} inputs · ${info.runs} recent runs`,
    );
  } else {
    console.log(`${C.dim(`RēDesign is not running (${base}). Start it with `)}${C.cyan("redesign serve")}`);
  }
}

export async function stopCmd(): Promise<void> {
  const base = await resolveServerBase();
  if (!(await probeServer(base))) {
    console.log(C.dim("RēDesign is not running."));
    return;
  }
  try {
    const res = await fetch(`${base}/api/shutdown`, { method: "POST" });
    console.log(res.ok ? C.green("Stopped RēDesign.") : C.red(`Shutdown refused (${res.status}).`));
  } catch (e) {
    console.log(C.red("Could not reach the server to stop it: ") + (e instanceof Error ? e.message : String(e)));
  }
}

export { probeServer, serverBase };

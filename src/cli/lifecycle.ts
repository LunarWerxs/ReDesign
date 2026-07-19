/**
 * Daemon-lifecycle + read-only introspection CLI commands: `serve`/`start` (boot the web UI + API
 * in-process), `status`, `stop`, and the local inspection verbs (`inputs`, `models`, `prompts`,
 * `references`, `keys`, `health-check`) that read straight off disk/config without needing a
 * running server. Extracted verbatim (behavior-preserving) from the old src/cli.js so the CLI
 * entry (src/cli/main.ts) stays a thin dispatcher.
 */
import { spawn } from "node:child_process";
import { C } from "../util";
import { listInputs, listReferences } from "../inputResolver";
import { loadModels, loadPrompts, resolveModels } from "../config";
import { getKeyManager } from "../runner";
import { healthCheckModel } from "../healthCheck";
import { startAutoUpdate, setAutoUpdateHooks } from "../auto-update";
import { findLiveInstance } from "../instance";
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
  // Boot the web UI + API in-process, the same server as `npm start`, but reachable from the one
  // `redesign` command an agent already knows. --port/--host override (read by http/serve.ts at
  // load, so set them BEFORE importing it).
  if (args.port) process.env.PORT = String(args.port);
  if (args.host) process.env.HOST = String(args.host);

  // Single-instance guard: if a RedDesign daemon is already serving (found via the runtime
  // pointer, or by probing the preferred port directly), don't start a second one, it would
  // just hop to another port and the CLI/tray would disagree about which instance is "the" one.
  // REDESIGN_PORT_FIXED=1 and REDESIGN_RELAUNCH=1 (the auto-update successor, which is SUPPOSED
  // to take over the same port from its predecessor) are exempt from this guard.
  if (process.env.REDESIGN_PORT_FIXED !== "1" && process.env.REDESIGN_RELAUNCH !== "1") {
    const live = await findLiveInstance();
    if (live) {
      console.log(C.yellow(`RēDesign is already running → ${live.url}`));
      return;
    }
  }
  const { startServer, shutdown } = await import("../http/serve");
  await startServer();

  // Auto-update loop (opt-in; see src/auto-update.ts). When it applies an update it must restart
  // the daemon ITSELF, RēDesign has no separate tray supervisor that relaunches us. So hand it a
  // relaunch that spawns a DETACHED copy of this exact launch command (REDESIGN_RELAUNCH=1 so the
  // successor's http/serve.ts bindWithRetry can tell this is an expected same-port handoff), then
  // gracefully shuts THIS daemon down (reusing serve.ts's own shutdown) to free the port.
  setAutoUpdateHooks({
    relaunch: () => {
      try {
        // process.argv[0] is the node executable path; process.execPath is the documented,
        // always-defined equivalent, used here only as the guard's fallback (never expected to
        // actually differ at runtime).
        const execPath = process.argv[0] ?? process.execPath;
        const child = spawn(execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, REDESIGN_RELAUNCH: "1" },
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

export { serverBase, probeServer };

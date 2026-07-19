/**
 * Boot the Hono app on Bun.serve. Dynamic-port + instance-pointer pattern (matches RepoYeti and
 * ccmanagerui): the daemon hops to a free port when the preferred one is held by a foreign
 * process, records where it actually bound in ~/.redesign/runtime.json (src/instance.ts), and
 * exits early if a live instance is already answering there. SIGINT/SIGTERM graceful shutdown and
 * the startup console banner (models/keys loaded, settled-orphan-runs note, "web UI not built"
 * warning) are unchanged.
 *
 * Boot policy, in order:
 *   1. REDESIGN_RELAUNCH=1 (the auto-update successor): same-port bindWithRetry, unchanged from
 *      before this port-hop change. The predecessor's graceful shutdown() frees the socket and
 *      this retry loop waits for it, so the successor rebinds the EXACT SAME port an open
 *      browser tab's SSE connection and bookmarks already point at.
 *   2. REDESIGN_PORT_FIXED=1 (sibling-parity escape hatch): bind PORT exactly, no probe, no hop.
 *   3. Otherwise: findFreePort(PORT, 50, HOST) picks a free port (usually PORT itself), then a
 *      short bindWithRetry on THAT port guards the race between the probe and the real bind.
 *
 * Extracted so the `redesign serve` CLI verb (src/cli/lifecycle.ts's serveCmd) can start the
 * exact same server in-process instead of shelling out, a --port passed to the CLI is applied by
 * setting process.env.PORT before this module's PORT/HOST consts are read. Also still runnable
 * directly (`bun src/http/serve.ts`) via the entry-module guard.
 */
import fs from "node:fs";
import path from "node:path";
import { C } from "../util";
import { loadModels } from "../config";
import { getKeyManager } from "../runner";
import * as store from "../store";
import { ORPHANED_RUN_MESSAGE } from "./runQueue";
import { createApp } from "./app";
import { WEB_ROOT } from "./web";
import * as connections from "../connections";
import { stopAutoUpdate } from "../auto-update";
import { findFreePort } from "../find-free-port.mjs";
import { writeInstanceInfo, clearInstanceInfo, clearShutdownRequest } from "../instance";
import { loadAppSettings } from "../app-settings";

const PORT = Number.parseInt(process.env.PORT || "", 10) || 5178;
const HOST = process.env.HOST || "127.0.0.1";

// Same-port retry, used for the REDESIGN_RELAUNCH=1 auto-update handoff (see the header comment)
// and as a short race guard on whatever port the dynamic-port path picks.
const LISTEN_RETRY_MS = 400;
const LISTEN_MAX_RETRIES = 25; // ~10s of grace for the old socket to release

let server: ReturnType<typeof Bun.serve> | null = null;
let cleanedUp = false;

/** Graceful stop: close the listener, clear the instance pointer, then exit. Exported so
 *  cli/lifecycle.ts's auto-update relaunch (src/auto-update.ts) can reuse the exact same
 *  teardown after spawning its successor. */
function shutdown(): void {
  try {
    stopAutoUpdate();
    cleanupInstance();
    server?.stop(true);
  } finally {
    process.exit(0);
  }
}

/** Clear the runtime.json pointer exactly once, from whichever exit path fires first
 *  (graceful shutdown(), SIGINT/SIGTERM, or the process 'exit' event as a last-resort net). */
function cleanupInstance(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  clearInstanceInfo();
}

async function bindWithRetry(
  fetchFn: (req: Request) => Response | Promise<Response>,
  port: number,
  attempt = 0,
): Promise<ReturnType<typeof Bun.serve>> {
  try {
    return Bun.serve({
      port,
      hostname: HOST,
      idleTimeout: 0, // long-lived SSE; we send our own keepalive
      fetch: fetchFn,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE" && attempt < LISTEN_MAX_RETRIES) {
      if (attempt === 0) {
        console.error(C.dim(`  ⚠ Port ${port} still in use, waiting for the previous instance to exit...`));
      }
      await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_MS));
      return bindWithRetry(fetchFn, port, attempt + 1);
    }
    console.error(
      C.bold(`\n  ✖ Could not bind ${HOST}:${port}`) + C.dim(`, ${err instanceof Error ? err.message : String(err)}\n`),
    );
    process.exit(1);
  }
}

/** Boot the HTTP server. Mirrors server.js's startServer(), plus the dynamic-port hop and
 *  instance-pointer bookkeeping described in the header comment. */
async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
  const app = createApp({ requestShutdown: shutdown });

  let boundPort: number;
  if (process.env.REDESIGN_RELAUNCH === "1") {
    // Auto-update successor: rebind the SAME port the predecessor held, waiting out its
    // graceful shutdown via the retry loop. Never hops, so SSE/bookmarks stay valid.
    server = await bindWithRetry(app.fetch, PORT);
    boundPort = PORT;
  } else if (process.env.REDESIGN_PORT_FIXED === "1") {
    // Sibling-parity escape hatch: bind PORT exactly, no probe, no hop.
    server = await bindWithRetry(app.fetch, PORT);
    boundPort = PORT;
  } else {
    // Default: hop to a free port when PORT is held by a foreign process. findFreePort race-free
    // probes candidates starting at PORT; bindWithRetry then guards the (tiny) race between that
    // probe and the real bind.
    const port = await findFreePort(PORT, 50, HOST);
    server = await bindWithRetry(app.fetch, port);
    boundPort = port;
  }

  // extra: publish portableMode + hideTrayIcon so the tray/start.cmd launcher knows, on a cold
  // start (before it can ask the daemon anything), whether to open an app window instead of a
  // normal tab, and whether to keep the notification-area icon hidden.
  writeInstanceInfo(boundPort, {
    portableMode: loadAppSettings().portableMode === true,
    hideTrayIcon: loadAppSettings().hideTrayIcon === true,
  });
  // Clear any stale "full shutdown" sentinel from a previous (possibly hard-killed) run so a
  // leftover can't make a freshly-launched tray quit the instant it starts; only a genuine
  // in-session UI shutdown (POST /api/shutdown) writes a fresh one. See src/instance.ts.
  clearShutdownRequest();
  process.on("exit", cleanupInstance);

  const settled = store.settleStaleRuns({ staleAfterMs: 0, reason: ORPHANED_RUN_MESSAGE }).settled;

  // "Sync my settings with Connections", load the persisted refresh token, then (if the owner
  // enabled sync) pull the cloud copy in the background so a fresh machine converges without
  // blocking boot; the web reads the applied appearance from GET /api/settings/sync on load.
  connections.initConnections();
  if (connections.syncStatus().enabled) void connections.pullNow().catch(() => {});

  const km = getKeyManager();
  let totalKeys = 0;
  for (const m of loadModels()) totalKeys += km.poolSize(m.keyEnv);
  const moved = boundPort !== PORT ? C.dim(`  (port ${PORT} was busy)`) : "";
  console.log(C.bold("\n  RēDesign") + C.dim(" (ReDesign), screenshot → many AIs → reimagined UIs\n"));
  console.log(`  ▸ UI:      ${C.cyan(`http://${HOST}:${boundPort}/`)}${moved}`);
  console.log(`  ▸ Viewer:  ${C.cyan(`http://${HOST}:${boundPort}/viewer`)}`);
  console.log(C.dim(`  ▸ ${loadModels().length} models · ${totalKeys} keys loaded · inputs in ./input\n`));
  if (settled.length) {
    console.log(C.dim(`  ▸ finalized ${settled.length} interrupted run${settled.length === 1 ? "" : "s"}\n`));
  }
  if (!fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
    console.log(C.dim("  ⚠ Web UI not built, run ") + C.cyan("npm run build") + C.dim(" (dev: npm run dev:web)\n"));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server as ReturnType<typeof Bun.serve>;
}

// `bun src/http/serve.ts` runs this directly (mirrors server.js's `require.main === module` guard).
if (import.meta.main) void startServer();

export { startServer, shutdown, PORT, HOST };

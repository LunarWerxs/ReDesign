/**
 * Boot the Hono app on Bun.serve, preserving server.js's startServer() semantics exactly: bind
 * 127.0.0.1 (or $HOST), same-port EADDRINUSE retry (NOT RepoYeti's hop-to-a-free-port walk, see
 * the comment below), SIGINT/SIGTERM graceful shutdown, and the startup console banner
 * (models/keys loaded, settled-orphan-runs note, "web UI not built" warning).
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

const PORT = Number.parseInt(process.env.PORT || "", 10) || 5178;
const HOST = process.env.HOST || "127.0.0.1";

// On a Rebuild & Restart the previous instance is force-killed, and Windows can hold the listen
// socket for a moment after that. Rather than crash on EADDRINUSE, wait for the port to free and
// retry so the restart self-heals. This intentionally retries the SAME port instead of hopping to
// a free one (unlike RepoYeti/DevWebUI's findFreePort-style walk-upward strategy), the launcher
// force-kills the old instance and expects the new one to come back on the exact same port, not a
// different one the UI/bookmarks don't expect. This same retry loop is what lets the auto-update
// relaunch's successor (spawned with REDESIGN_RELAUNCH=1, see src/cli/lifecycle.ts's serveCmd)
// rebind the SAME port: it just retries EADDRINUSE until the predecessor's graceful shutdown()
// frees the socket, so no separate "wait for port free" probe is needed here.
const LISTEN_RETRY_MS = 400;
const LISTEN_MAX_RETRIES = 25; // ~10s of grace for the old socket to release

let server: ReturnType<typeof Bun.serve> | null = null;

/** Graceful stop: close the listener, then exit. Exported so cli/lifecycle.ts's auto-update
 *  relaunch (src/auto-update.ts) can reuse the exact same teardown after spawning its successor. */
function shutdown(): void {
  try {
    stopAutoUpdate();
    server?.stop(true);
  } finally {
    process.exit(0);
  }
}

async function bindWithRetry(fetchFn: (req: Request) => Response | Promise<Response>, attempt = 0): Promise<ReturnType<typeof Bun.serve>> {
  try {
    return Bun.serve({
      port: PORT,
      hostname: HOST,
      idleTimeout: 0, // long-lived SSE; we send our own keepalive
      fetch: fetchFn,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE" && attempt < LISTEN_MAX_RETRIES) {
      if (attempt === 0) {
        console.error(C.dim(`  ⚠ Port ${PORT} still in use, waiting for the previous instance to exit...`));
      }
      await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_MS));
      return bindWithRetry(fetchFn, attempt + 1);
    }
    console.error(
      C.bold(`\n  ✖ Could not bind ${HOST}:${PORT}`) + C.dim(`, ${err instanceof Error ? err.message : String(err)}\n`),
    );
    process.exit(1);
  }
}

/** Boot the HTTP server. Mirrors server.js's startServer(). */
async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
  const app = createApp({ requestShutdown: shutdown });
  server = await bindWithRetry(app.fetch);

  const settled = store.settleStaleRuns({ staleAfterMs: 0, reason: ORPHANED_RUN_MESSAGE }).settled;

  // "Sync my settings with Connections", load the persisted refresh token, then (if the owner
  // enabled sync) pull the cloud copy in the background so a fresh machine converges without
  // blocking boot; the web reads the applied appearance from GET /api/settings/sync on load.
  connections.initConnections();
  if (connections.syncStatus().enabled) void connections.pullNow().catch(() => {});

  const km = getKeyManager();
  let totalKeys = 0;
  for (const m of loadModels()) totalKeys += km.poolSize(m.keyEnv);
  console.log(C.bold("\n  RēDesign") + C.dim(" (ReDesign), screenshot → many AIs → reimagined UIs\n"));
  console.log("  ▸ UI:      " + C.cyan(`http://${HOST}:${PORT}/`));
  console.log("  ▸ Viewer:  " + C.cyan(`http://${HOST}:${PORT}/viewer`));
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

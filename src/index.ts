#!/usr/bin/env bun
/**
 * redesign bin entry, a thin shebang shim. All command logic lives in src/cli/ (main.ts
 * dispatches; lifecycle.ts boots the daemon + read-only introspection verbs; run.ts is the
 * in-process `run` verb; MCP lives in src/mcp/). Kept at src/index.ts because that's the
 * published `bin` target (see package.json) and the compiled-binary entry (scripts/build.ts).
 *
 * NB: we intentionally do NOT call process.exit(). Forcing exit while undici (global fetch) still
 * has open keep-alive handles triggers a libuv assertion on Windows. All of our own timers are
 * unref'd/cleared, so the event loop drains and the process exits cleanly on its own. (Ported
 * verbatim from the old src/cli.js's own comment/guard.)
 */
import { C } from "./util";
import { main } from "./cli/main";

main(process.argv.slice(2))
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    console.error(`\n${C.red("Error: ")}${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  });

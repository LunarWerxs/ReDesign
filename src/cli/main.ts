/**
 * redesign CLI dispatcher. `redesign <command> [args]`. Ported from the old src/cli.js switch,
 * keeping the same `parseArgs` shape and the same verb set, only the plumbing changed (each verb's
 * body now lives in ./lifecycle.ts or ./run.ts; MCP lives in ../mcp/stdio.ts).
 */
import { C } from "../util";
import { parseArgs } from "./args";
import {
  inputsCmd,
  modelsCmd,
  promptsCmd,
  referencesCmd,
  keysCmd,
  healthCheckCmd,
  serveCmd,
  statusCmd,
  stopCmd,
} from "./lifecycle";
import { runCmd } from "./run";
import { runStdioMcp } from "../mcp/stdio";

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] || "help";
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case "inputs":
      inputsCmd();
      break;

    case "models":
      modelsCmd();
      break;

    case "prompts":
      promptsCmd();
      break;

    case "references":
    case "refs":
      referencesCmd();
      break;

    case "keys":
      keysCmd(args);
      break;

    case "health-check":
      await healthCheckCmd(args);
      break;

    case "run":
      await runCmd(args);
      break;

    case "serve":
    case "start":
      await serveCmd(args);
      break;

    case "status":
      await statusCmd(args);
      break;

    case "stop":
      await stopCmd();
      break;

    case "mcp":
      // Run the stdio MCP server (for AI agents). It proxies to the running server, so start that
      // first with `redesign serve`. Only writes JSON-RPC to stdout.
      await runStdioMcp();
      break;
    default:
      printHelp();
      break;
  }
}

function printHelp(): void {
  console.log(`
${C.bold("RēDesign")} (ReDesign), run UI screenshots through many AI models.

  ${C.cyan("npm run inputs")}                         list discovered inputs
  ${C.cyan("npm run models")}                         list models + key counts
  ${C.cyan("npm run prompts")}                        list default prompt presets
  ${C.cyan("bun run src/index.ts references")}        list reference images (reference/)
  ${C.cyan("npm run keys")} [-- --json]               show key-pool health
  ${C.cyan("npm run health-check")} [-- --models a,b] ping keys live (spends quota)
  ${C.cyan("npm run run-job")} [-- options]           run a batch

  ${C.cyan("redesign serve")} [--port N] [--host h]   start the web UI + API (foreground)
  ${C.cyan("redesign status")} [--json]               is the server running + a quick snapshot
  ${C.cyan("redesign stop")}                          gracefully stop a running server
  ${C.cyan("redesign mcp")}                           stdio MCP server for AI agents (serve first)

  run options:
    --input  all|id,id      which inputs        (default all)
    --models all|id,id      which models        (default all)
    --prompts all|id,id     which presets       (default all, or none if --custom)
    --custom "text"         add a custom prompt
    --reference all|a.png,b  feed style reference image(s) from reference/
    --reference-note "text"  tell the model how to use the reference
    --variants N            outputs per model/prompt (default 1)
    --mock                  no real API calls, placeholder HTML (for testing)
    --concurrency N         max parallel calls across the whole run
    --pool-concurrency N    max parallel calls per key pool/provider lane
    --max-images N          cap reference images per group
    --label name            tag the run id

  ${C.dim("Web UI:")} ${C.cyan("npm start")}  →  http://localhost:${process.env.PORT || 5178}
`);
}

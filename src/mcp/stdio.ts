/**
 * The stdio MCP server: what `redesign mcp` runs, and what an MCP client (Claude Desktop/Code,
 * Cursor) spawns. It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and proxies every tool
 * call to the RUNNING RēDesign server over HTTP (./tools.ts).
 *
 * The protocol dispatch + the stdin→dispatch→stdout loop live in the SHARED engine
 * (../mcp-stdio.mjs, part of the shared kit, edit it there, never here). This file is
 * just the thin RēDesign binding: a static import replaces the old mcp.js's dynamic
 * `import('./mcp-stdio.mjs')` bridge now that this file itself is ESM/TS.
 */
import { runMcpStdio } from "../mcp-stdio.mjs";
import { TOOLS } from "./tools";

/** Run the stdio server loop until stdin closes, proxying tool calls to the running server. */
export function runStdioMcp(): Promise<void> {
  return runMcpStdio({ serverInfo: { name: "redesign", version: "1.0.0" }, tools: TOOLS });
}

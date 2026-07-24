/**
 * The `redesign run` verb: runs a batch IN-PROCESS (bypassing the HTTP run-queue/SSE that
 * `POST /api/run` uses), but still writes to store.ts so it shows up in `redesign status` / the
 * web UI's run history. Extracted verbatim from the old src/cli.js switch case so the CLI entry
 * (src/cli/main.ts) stays a thin dispatcher.
 */
import { C } from "../util";
import { runReimagine } from "../runner";
import type { Manifest } from "../store";
import type { SelectionInput } from "../util";
import type { Args } from "./args";

interface RunProgressEvent {
  type: string;
  runId?: string;
  total?: number;
  job?: {
    status: string;
    inputId: string;
    modelId: string;
    promptId: string;
    ms?: number;
    keyMask?: string;
    error?: string;
  };
}

// A CLI flag with no value parses to boolean `true` (see ./args.ts); runReimagine's
// SelectionInput doesn't accept a bare boolean, so fold `true` to the "all" sentinel (matching the
// string forms) and an absent/false flag to undefined (falls through to the caller's "all" default).
function asSelection(v: string | boolean | string[] | undefined): SelectionInput {
  if (v === true) return "all";
  if (v === false) return undefined;
  return v;
}

export async function runCmd(args: Args): Promise<void> {
  const opts = {
    inputs: asSelection(args.input || args.inputs) ?? "all",
    models: asSelection(args.models) ?? "all",
    prompts: {
      presets: asSelection(args.prompts) ?? (args.custom ? [] : "all"),
      custom: typeof args.custom === "string" ? args.custom : undefined,
    },
    reference: args.reference
      ? { images: args.reference === true ? "all" : args.reference, note: typeof args["reference-note"] === "string" ? args["reference-note"] : undefined }
      : null,
    variants: Number.parseInt(String(args.variants), 10) || 1,
    mock: !!args.mock || process.env.MOCK === "1",
    // --ground: feed vision models a full written inventory of the screenshot so they
    // reimagine every element instead of dropping/misreading content (one caption per input).
    groundWithDescription: !!args.ground,
    concurrency: Number.parseInt(String(args.concurrency), 10) || undefined,
    poolConcurrency: Number.parseInt(String(args["pool-concurrency"]), 10) || undefined,
    maxImagesPerInput: Number.parseInt(String(args["max-images"]), 10) || undefined,
    label: typeof args.label === "string" ? args.label : undefined,
  };
  console.log(
    C.bold("Starting run  ") +
      C.dim(`inputs=${opts.inputs} models=${opts.models} variants=${opts.variants} mock=${opts.mock}`),
  );
  const manifest: Manifest = await runReimagine({
    ...opts,
    onProgress: (event: Record<string, unknown>) => {
      const ev = event as unknown as RunProgressEvent;
      if (ev.type === "start") console.log(C.dim(`  ${ev.total} jobs queued → run ${ev.runId}\n`));
      else if (ev.type === "job" && ev.job && (ev.job.status === "ok" || ev.job.status === "error")) {
        const ok = ev.job.status === "ok";
        console.log(
          `  ${ok ? C.green("✓") : C.red("✗")} ${ev.job.inputId.padEnd(24)} ${ev.job.modelId.padEnd(16)} ` +
            `${ev.job.promptId.padEnd(16)} ${C.dim(`${ev.job.ms || 0}ms ${ev.job.keyMask || ""}`)}` +
            `${ok ? "" : C.red(`  ${(ev.job.error || "").slice(0, 70)}`)}`,
        );
      }
    },
  });
  const c = manifest.counts ?? { total: 0, done: 0, ok: 0, error: 0, skipped: 0 };
  console.log(
    `\n${C.bold("Done. ")}${C.green(`${c.ok} ok`)}  ${c.error ? C.red(`${c.error} error`) : "0 error"}  / ${c.total}` +
      C.dim(`\n  output/${manifest.runId}/   ·   view: npm start  then open /viewer?run=${manifest.runId}`),
  );
}

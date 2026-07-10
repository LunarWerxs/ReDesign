/**
 * Tiny CLI arg parser shared by every src/cli/*.ts module. Extracted verbatim (behavior-preserving)
 * from the old src/cli.js so main.ts/lifecycle.ts/run.ts can all import the same shape.
 */
export interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      // Support --key=value so a value may itself start with "--" or contain
      // spaces (e.g. --custom="--make it pop"); otherwise consume the next token.
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

export function table(rows: string[][]): string {
  return rows.map((r) => r.join("  ")).join("\n");
}

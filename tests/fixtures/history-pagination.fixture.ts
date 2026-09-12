import { mock } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";

const root = String(process.env.REDESIGN_TEST_ROOT || "");
if (!root) throw new Error("missing isolated root");

const util = await import("../../src/util");
let manifestReads = 0;
mock.module("../../src/util", () => ({
  ...util,
  ROOT: root,
  APP_CONFIG_DIR: path.join(root, "home"),
  ENV_FILE: path.join(root, "home", ".env"),
  readJSON<T>(file: string, fallback: T): T {
    if (file.endsWith(`${path.sep}manifest.json`)) manifestReads++;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch (_) {
      return fallback;
    }
  },
}));

const [{ OUTPUT_DIR }, { listRuns, listRunsPage }] = await Promise.all([import("../../src/store/paths"), import("../../src/store")]);

function runId(index: number): string {
  return `20260908-120000-${String(index).padStart(6, "0")}`;
}

function writeRun(index: number): string {
  const id = runId(index);
  const dir = path.join(OUTPUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ runId: id, createdAt: `2026-09-08T12:00:${String(index % 60).padStart(2, "0")}.000Z`, finishedAt: "2026-09-08T12:01:00.000Z", status: "done", mock: true, config: { modelIds: [], inputIds: [] }, jobs: [] }));
  return id;
}

const mode = process.argv[2];
if (mode === "history") {
  const count = Number(process.argv[3]);
  for (let index = 0; index < count; index++) writeRun(index);
  manifestReads = 0;
  listRuns();
  const firstReads = manifestReads;
  manifestReads = 0;
  const second = listRuns();
  const secondReads = manifestReads;
  manifestReads = 0;
  const page = listRunsPage({ limit: 50 });
  process.stdout.write(`${JSON.stringify({ firstReads, secondReads, pageReads: manifestReads, total: second.length, pageTotal: page.runs.length })}\n`);
} else if (mode === "pages") {
  const expected = Array.from({ length: 125 }, (_, index) => writeRun(index));
  fs.mkdirSync(path.join(OUTPUT_DIR, ".preflight"), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "notes.txt"), "not a run");
  for (const index of [9, 59, 109]) fs.mkdirSync(path.join(OUTPUT_DIR, `20269999-invalid-${index}`), { recursive: true });
  const ids: string[] = [];
  const pageLengths: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = listRunsPage({ cursor, limit: 50 });
    ids.push(...page.runs.map((run) => run.runId));
    pageLengths.push(page.runs.length);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const exhausted = listRunsPage({ cursor: ids.at(-1) || "20260908-000000-000000", limit: 50 }).runs;
  process.stdout.write(`${JSON.stringify({ total: expected.length, ids, pageLengths, exhausted, privateSeen: ids.some((id) => id.startsWith(".")) })}\n`);
} else {
  throw new Error(`invalid mode ${mode}`);
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLaunchLock } from "../src/launch-lock";

const dirs: string[] = [];
function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "redesign-launch-lock-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("only one launcher can pass the liveness decision at a time", () => {
  const configDir = tempConfig();
  const first = acquireLaunchLock(configDir);
  expect(first).not.toBeNull();
  expect(acquireLaunchLock(configDir)).toBeNull();
  first?.release();
  expect(acquireLaunchLock(configDir)).not.toBeNull();
});

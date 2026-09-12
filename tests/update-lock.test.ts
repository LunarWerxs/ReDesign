import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock, cleanupUpdateArtifacts } from "../src/update-lock";

const dirs: string[] = [];
function tempInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), "redesign-update-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("an active update lock prevents a second updater from entering the same install", () => {
  const installDir = tempInstall();
  const first = acquireUpdateLock(installDir);
  expect(first).not.toBeNull();
  expect(acquireUpdateLock(installDir)).toBeNull();
  first?.release();
  expect(acquireUpdateLock(installDir)).not.toBeNull();
});

test("cleanup leaves staging and rollback files alone while another updater owns them", () => {
  const installDir = tempInstall();
  const first = acquireUpdateLock(installDir);
  expect(first).not.toBeNull();
  const staging = join(installDir, ".update-staging");
  const rollback = join(installDir, "redesign.exe.old-1");
  writeFileSync(staging, "not-a-directory");
  writeFileSync(rollback, "rollback");

  cleanupUpdateArtifacts(installDir, "redesign.exe");

  expect(existsSync(staging)).toBe(true);
  expect(existsSync(rollback)).toBe(true);
  first?.release();
});

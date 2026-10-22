import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetForPlatform, checkForUpdate, downloadResponseToFile, isNewer, releaseTarget } from "../src/github-updater";

const direct = {
  name: "redesign-windows-x64.exe",
  browser_download_url: "https://example.test/direct",
  size: 100,
};
const archive = {
  name: "redesign-windows-x64.zip",
  browser_download_url: "https://example.test/archive",
  size: 40,
};

test("compiled updater selects the Windows archive regardless of direct-exe upload order", () => {
  expect(assetForPlatform([direct, archive], "win32", "x64")).toEqual(archive);
  expect(assetForPlatform([archive, direct], "win32", "x64")).toEqual(archive);
});

test("compiled updater uses the public release target names", () => {
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("macos-arm64");
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
});

test("release versions compare as numeric semver triples", () => {
  expect(isNewer("v1.4.1", "1.4.0")).toBe(true);
  expect(isNewer("1.4.0", "1.4.0")).toBe(false);
  expect(isNewer("1.3.9", "1.4.0")).toBe(false);
});

/**
 * The update check must survive its primary endpoint going away.
 *
 * This is the YTSort failure (2026-08) in a different shape: an artifact shipped with a single
 * baked-in update URL, that URL later stops resolving, and every install polls a dead link
 * forever with nothing surfaced to the user or the maintainer. One hardcoded endpoint and no
 * second opinion is that bug waiting to happen, so a Studio failure must fall through to
 * GitHub's own releases API, the one URL that survives an owner or repo rename.
 */
test("a failing Studio proxy falls back to GitHub instead of stranding the install", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("studio.connectionsapi.com")) return new Response("gone", { status: 503 });
    return new Response(JSON.stringify({ tag_name: "v999.0.0", assets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(seen.some((u) => u.includes("studio.connectionsapi.com"))).toBe(true);
    expect(seen.some((u) => u.includes("api.github.com"))).toBe(true);
    expect(status.updateAvailable).toBe(true);
  } finally {
    globalThis.fetch = real;
  }
});

test("both endpoints down reports the primary failure, not the backstop's", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("primary is unreachable");
  }) as unknown as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(status.ok).toBe(false);
    expect(String(status.reason)).toContain("primary is unreachable");
  } finally {
    globalThis.fetch = real;
  }
});

test("release archive download rejects a stream larger than its published asset size and removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "redesign-update-download-"));
  const file = join(dir, "candidate.zip");
  const response = new Response(new Uint8Array([1, 2, 3, 4]));
  try {
    await expect(downloadResponseToFile(response, file, 3, 10)).rejects.toThrow("larger than expected");
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release archive download writes exactly the published size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "redesign-update-download-"));
  const file = join(dir, "candidate.zip");
  try {
    await downloadResponseToFile(new Response(new Uint8Array([1, 2, 3])), file, 3, 10);
    expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

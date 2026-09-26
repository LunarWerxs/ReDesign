/**
 * GitHub Releases updater for the compiled, single-file distribution.
 *
 * Human-facing Windows releases expose both a direct .exe and a smaller .zip. This updater
 * deliberately selects only the platform archive, verifies its version, and atomically swaps the
 * executable. Source checkouts continue to use updater-engine.mjs through updater.ts.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import pkg from "../package.json";
import { coarseOsTag, getInstallId, PING_URL } from "./install-ping";
import { cleanupUpdateArtifacts } from "./update-lock";
import type { UpdateApplyResult, UpdateStatus } from "./updater-engine.mjs";

const SERVICE = "redesign";
const REPO = "LunarWerxs/ReDesign";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
// Studio's app-ping proxy: relays GitHub's releases/latest JSON for this repo verbatim (so
// everything below is unchanged from talking to api.github.com directly), and logs one
// anonymous install-count row per hit server-side — random id + version + coarse OS, never an
// IP, hostname, username, or path. This IS the update check, not a second network call added
// alongside it. See src/install-ping.ts for the shared id/OS plumbing and the from-source
// boot-time ping this doesn't cover.
const LATEST_API = PING_URL;
/**
 * Resilience fallback, used only when the Studio proxy fails (see latestRelease). GitHub's own
 * releases/latest is the right backstop precisely because it is the one URL here a rename
 * cannot orphan: GitHub redirects both owner and repo renames.
 *
 * Why this exists (YTSort, 2026-08): a shipped artifact whose only update URL later stopped
 * resolving left every install silently polling a dead link for six months, with no signal to
 * the users or the maintainer. One hardcoded endpoint and no second opinion is that same
 * failure waiting to happen.
 */
const GITHUB_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const VERSION = pkg.version;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 1_024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1_024 * 1024;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return `${os}-${arch}`;
}

/** Select only the compressed updater bundle, never the direct Windows executable. */
export function assetForPlatform(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset | null {
  const extension = platform === "win32" ? ".zip" : ".tar.gz";
  const expected = `redesign-${releaseTarget(platform, arch)}${extension}`;
  return assets.find((asset) => asset.name === expected) ?? null;
}

function numericVersion(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(remote: string, local: string): boolean {
  const a = numericVersion(remote);
  const b = numericVersion(local);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function baseStatus(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: SERVICE,
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: null,
    branch: null,
    upstream: null,
    remote: RELEASES_PAGE,
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: Date.now(),
    reason: null,
    ...overrides,
  };
}

/**
 * Ask GitHub directly after the Studio proxy failed. Carries no install id and no version/os
 * telemetry: a plain unauthenticated read, well inside GitHub's anonymous rate limit.
 *
 * If this fails too, the ORIGINAL failure is reported. The primary endpoint is the one an
 * operator needs to hear about; leading with "GitHub said 403" would send them chasing the
 * backstop instead of the thing that actually broke.
 */
async function githubFallbackRelease(
  common: Record<string, string>,
  primaryError: unknown,
  primaryStatus: number | undefined,
): Promise<Release> {
  let fallback: Response;
  try {
    fallback = await fetch(GITHUB_LATEST_API, {
      headers: common,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw primaryError ?? error;
  }
  if (!fallback.ok) {
    if (primaryError) throw primaryError;
    throw new Error(
      `release check returned HTTP ${primaryStatus} (GitHub fallback: HTTP ${fallback.status})`,
    );
  }
  return (await fallback.json()) as Release;
}

async function latestRelease(): Promise<Release> {
  const qs = new URLSearchParams({ v: VERSION, os: coarseOsTag() });
  const common = {
    accept: "application/vnd.github+json",
    "user-agent": `${SERVICE}/${VERSION}`,
  };
  let response: Response | null = null;
  let primaryError: unknown = null;
  try {
    response = await fetch(`${LATEST_API}?${qs.toString()}`, {
      headers: { ...common, "X-Install-Id": getInstallId() },
      // Without a deadline the most likely failure — a network that accepts the connection and
      // then goes quiet — would hang here forever and never reach the fallback below, making
      // the fallback useless in exactly the case it exists for. Matches the sibling apps.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    primaryError = error;
  }
  if (response?.ok) return (await response.json()) as Release;
  return await githubFallbackRelease(common, primaryError, response?.status);
}

let cached: { status: UpdateStatus; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function checkForUpdate(options: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  try {
    const release = await latestRelease();
    const remoteVersion = release.tag_name?.replace(/^v/, "") ?? "";
    const available = !!remoteVersion && isNewer(remoteVersion, VERSION);
    const asset = available ? assetForPlatform(release.assets ?? []) : null;
    const status = baseStatus({
      remoteCommit: release.tag_name ?? null,
      updateAvailable: available,
      canApply: available && !!asset,
      reason:
        available && !asset
          ? `v${remoteVersion} is available, but its ${releaseTarget()} archive is missing.`
          : null,
    });
    cached = { status, at: Date.now() };
    return status;
  } catch (error) {
    return baseStatus({
      ok: false,
      reason: `couldn't check GitHub Releases (${error instanceof Error ? error.message : String(error)}).`,
    });
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "null"}`)),
    );
  });
}

async function extract(archive: string, destination: string): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
  } else {
    await run("tar", ["-xzf", archive, "-C", destination]);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
  return hash.digest("hex");
}

/**
 * The digest SHA256SUMS.txt records for `assetName`, or null when the file or the entry is
 * missing. Every release publishes this file (see .github/workflows/release.yml "Build checksums"),
 * where it is generated with `sha256sum` and stripped down to bare asset names.
 *
 * This is the ONLY thing standing between a hijacked release and code execution: without it the
 * next check downloads whatever the API points at, and verifyVersion() below "validates" it by
 * RUNNING it. So a missing or unparseable sums file is a hard stop, never a warn-and-continue.
 */
async function expectedSha256(release: Release | null, assetName: string): Promise<string | null> {
  const sums = (release?.assets ?? []).find((a) => a.name === "SHA256SUMS.txt");
  if (!sums) return null;
  let text: string;
  try {
    const response = await fetch(sums.browser_download_url, {
      headers: { accept: "text/plain", "user-agent": `${SERVICE}/${VERSION}` },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    text = new TextDecoder().decode(await readResponseWithLimit(response, MAX_CHECKSUM_BYTES));
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    // `sha256sum` output: "<64 hex>  <name>", with a leading '*' on the name in binary mode.
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, digest, name] = match;
    if (digest && name && basename(name) === assetName) return digest.toLowerCase();
  }
  return null;
}

/** Read a finite response with a hard cap; callers never retain an unbounded update payload. */
async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`download exceeds ${maxBytes} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`download exceeds ${maxBytes} byte limit`);
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Reject a published asset size we must never stream: non-integer, non-positive, or over the ceiling. */
function assertSafeExpectedBytes(expectedBytes: number, maximumBytes: number): void {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes) {
    throw new Error("release asset has an invalid or unsafe published size");
  }
}

/** Reject a response whose own content-length disagrees with the published asset size. */
function assertContentLengthMatches(response: Response, expectedBytes: number): void {
  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  if (Number.isFinite(contentLength) && contentLength !== expectedBytes) {
    throw new Error("download size does not match the published asset size");
  }
}

/** Backpressure: wait for the write stream to drain (or to error) before handing it another chunk. */
function waitForDrain(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    writer.once("drain", resolve);
    writer.once("error", reject);
  });
}

/** Close the write stream, surfacing a late write error the way `end` reports it. */
function closeWriter(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    writer.end((error?: Error | null) => (error ? reject(error) : resolve())),
  );
}

/** Destroy `writer` and settle once its file handle is closed (bounded, so a stuck stream never hangs an update). */
function destroyWriter(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise<void>((resolve) => {
    if (writer.closed) return resolve();
    const timer = setTimeout(resolve, 5_000);
    writer.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    writer.destroy();
  });
}

/** Pump the body into `writer`, returning the byte count; overruns throw as soon as they are seen. */
async function pumpBodyToWriter(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: ReturnType<typeof createWriteStream>,
  expectedBytes: number,
  maximumBytes: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes || total > maximumBytes) throw new Error("download is larger than expected");
    if (!writer.write(value)) await waitForDrain(writer);
  }
  return total;
}

/**
 * Stream a release asset to disk while enforcing both GitHub's published size and an absolute
 * safety ceiling. Failure always removes the partial file, so cleanup is not deferred to a
 * future launch.
 */
export async function downloadResponseToFile(
  response: Response,
  destination: string,
  expectedBytes: number,
  maximumBytes = MAX_ARCHIVE_BYTES,
): Promise<void> {
  assertSafeExpectedBytes(expectedBytes, maximumBytes);
  assertContentLengthMatches(response, expectedBytes);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("download has no response body");
  const writer = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    const total = await pumpBodyToWriter(reader, writer, expectedBytes, maximumBytes);
    if (total !== expectedBytes) throw new Error("download size does not match the published asset size");
    await closeWriter(writer);
  } catch (error) {
    // The stream opens its file asynchronously: remove it only once the stream has closed, or a
    // still-pending open recreates the file after the removal (seen under load, harvest F).
    await destroyWriter(writer);
    rmSync(destination, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function verifyVersion(executable: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim().replace(/^v/, "") === expected.replace(/^v/, ""));
    });
  });
}

function moveInto(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch {
    cpSync(source, destination);
    rmSync(source, { force: true });
  }
}

function failure(message: string): UpdateApplyResult {
  return {
    ok: false,
    message,
    restartRequired: false,
    status: baseStatus({ ok: false, reason: message }),
    output: [],
  };
}

// Downloads the release asset, authenticates it against the published checksum, unpacks it, and
// verifies the extracted binary reports the expected version. Pulled out of applyUpdate so this
// chain of guard clauses scores against this function instead of applyUpdate's; returns the
// staged candidate path on success, or the failure result to return verbatim on any check.
async function downloadAndStageUpdate(
  asset: ReleaseAsset,
  release: Release,
  remoteVersion: string,
  staging: string,
  bundledName: string,
): Promise<{ ok: true; candidate: string; output: string[] } | { ok: false; result: UpdateApplyResult }> {
  const output: string[] = [];
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, asset.name);
  output.push(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MB)`);
  let response: Response;
  try {
    response = await fetch(asset.browser_download_url, {
    headers: { accept: "application/octet-stream", "user-agent": `${SERVICE}/${VERSION}` },
    redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`download failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
  if (!response.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`download failed (HTTP ${response.status})`) };
  }
  try {
    await downloadResponseToFile(response, archive, asset.size);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`download failed: ${error instanceof Error ? error.message : String(error)}`) };
  }

  // Authenticate the download BEFORE unpacking it and long before verifyVersion() executes it.
  // Auto-update is on by default and unattended, so this check is what keeps a hijacked release
  // from becoming silent code execution on every install.
  const expected = await expectedSha256(release, asset.name);
  if (!expected) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`no published checksum for ${asset.name}; refusing to install v${remoteVersion}`) };
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    output.push(`checksum mismatch: expected ${expected}, got ${actual}`);
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`${asset.name} failed its checksum; refusing to install v${remoteVersion}`) };
  }
  output.push("checksum verified");

  try {
    await extract(archive, staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`could not unpack update: ${error instanceof Error ? error.message : String(error)}`) };
  }

  const candidate = join(staging, bundledName);
  if (!existsSync(candidate)) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure(`the update archive has no ${bundledName}`) };
  }
  if (!(await verifyVersion(candidate, remoteVersion))) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, result: failure("the downloaded executable failed its version self-check") };
  }
  return { ok: true, candidate, output };
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
  const status = await checkForUpdate({ fresh: true });
  if (!status.ok) return failure(status.reason ?? "update check failed");
  if (!status.updateAvailable) return failure("already up to date");

  const remoteVersion = (status.remoteCommit ?? "").replace(/^v/, "");
  let release: Release | null = null;
  let asset: ReleaseAsset | null = null;
  try {
    release = await latestRelease();
    asset = assetForPlatform(release.assets ?? []);
  } catch {}
  if (!asset || !release) return failure(`no ${releaseTarget()} archive is attached to v${remoteVersion}`);

  const executable = process.execPath;
  const installDir = dirname(executable);
  const staging = join(installDir, ".update-staging");
  const oldExecutable = join(installDir, `${basename(executable)}.old-${status.checkedAt}`);
  const bundledName = process.platform === "win32" ? "redesign.exe" : "redesign";
  let movedAside = false;

  try {
    const staged = await downloadAndStageUpdate(asset, release, remoteVersion, staging, bundledName);
    if (!staged.ok) return staged.result;
    const { candidate, output } = staged;

    renameSync(executable, oldExecutable);
    movedAside = true;
    moveInto(candidate, executable);
    if (process.platform !== "win32") {
      try {
        await run("chmod", ["+x", executable]);
      } catch {}
    }
    rmSync(staging, { recursive: true, force: true });
    cached = null;
    output.push(`installed v${remoteVersion}`);
    return {
      ok: true,
      message: `Updated to v${remoteVersion}. Restarting…`,
      restartRequired: true,
      status: baseStatus({ currentVersion: remoteVersion }),
      output,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (movedAside && existsSync(oldExecutable)) {
      try {
        rmSync(executable, { force: true });
        renameSync(oldExecutable, executable);
      } catch {}
    }
    return failure(`update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function cleanupStaleUpdateArtifacts(): void {
  try {
    const installDir = dirname(process.execPath);
    const executableName = basename(process.execPath);
    cleanupUpdateArtifacts(installDir, executableName);
  } catch {}
}

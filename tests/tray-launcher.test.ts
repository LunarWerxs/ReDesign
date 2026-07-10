// THE TRAY GUARD, hardcore red, thou shalt not pass. The product MUST always
// ship a clickable shortcut in the project ROOT that, when run, boots the
// environment (bun src/index.ts serve) and raises the system-tray icon. If any
// link in that chain breaks, the shortcut is gone, it points at a stale/dead
// path, the launcher no longer starts the server or the tray, or the icon won't
// load, these assertions fail and `bun test` exits non-zero.
//
// Windows-only: the launcher chain (.lnk / .vbs / tray .ps1 / NotifyIcon) is a
// Windows concept. Gated so Linux/Mac CI doesn't fail on an inapplicable check.
import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";

const describeWin32 = process.platform === "win32" ? describe : describe.skip;

describeWin32("tray launcher: root shortcut → environment + tray icon", () => {
  const repoRoot = path.join(import.meta.dir, "..");
  const lnkPath = path.join(repoRoot, "RēDesign.lnk");
  const vbsPath = path.join(repoRoot, "misc", "Reimagine.vbs");
  const trayPath = path.join(repoRoot, "misc", "ReDesign-Tray.ps1");
  const icoPath = path.join(repoRoot, "misc", "Reimagine.ico");

  // Normalize a (possibly quoted / icon-indexed) path and compare it to a real
  // file on disk, case-insensitively (Windows paths).
  const samePath = (a: unknown, b: string) =>
    path.resolve(String(a || "").replace(/^"|"$/g, "").trim()).toLowerCase() === path.resolve(b).toLowerCase();

  // The root shortcut is a generated, machine-specific artifact: a .lnk stores an
  // absolute path, so a committed copy would point at whatever machine last built it
  // (and fail this check in CI). It is git-ignored, never committed. Regenerate it
  // fresh here so these assertions validate THIS checkout's launcher chain.
  beforeAll(() => {
    try {
      cp.execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "misc", "Create-Shortcut.ps1")],
        { stdio: "ignore" },
      );
    } catch (_) {
      // If generation fails, the existence assertion below surfaces it.
    }
  });

  it('a "RēDesign" shortcut exists in the project root', () => {
    expect(fs.existsSync(lnkPath)).toBe(true);
  });

  it("every file the shortcut drives is present (vbs, tray host, icon)", () => {
    expect(fs.existsSync(vbsPath)).toBe(true);
    expect(fs.existsSync(trayPath)).toBe(true);
    expect(fs.existsSync(icoPath)).toBe(true);
  });

  it("the tray icon carries a tray-sized (<=48px) frame in a valid multi-frame ICO", () => {
    if (!fs.existsSync(icoPath)) return;
    const ico = fs.readFileSync(icoPath);
    const count = ico.length >= 6 ? ico.readUInt16LE(4) : 0;
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      if (off + 1 < ico.length) {
        const w = ico[off]!;
        sizes.push(w === 0 ? 256 : w);
      }
    }
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(count).toBeGreaterThan(0);
    expect(sizes.length).toBe(count);
    expect(sizes.some((w) => w > 0 && w <= 48)).toBe(true);
  });

  it("the launcher chain actually starts the environment + the tray icon", () => {
    const vbs = fs.existsSync(vbsPath) ? fs.readFileSync(vbsPath, "utf8") : "";
    expect(/ReDesign-Tray\.ps1/i.test(vbs)).toBe(true);

    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/bun/i.test(tray) && /index\.ts/i.test(tray)).toBe(true);
    expect(/NotifyIcon/i.test(tray)).toBe(true);
    expect(/System\.Threading\.Mutex/i.test(tray) && /WaitOne\(0/i.test(tray)).toBe(true);
    expect(/tray icon is not running/i.test(tray) && /Stop that process/i.test(tray)).toBe(true);

    const trayIconIndex = tray.search(/New-Object\s+System\.Windows\.Forms\.NotifyIcon/i);
    const startServerIndex = tray.search(/Start-Server\s+\$root\s+\$port\s+\|\s+Out-Null/i);
    expect(trayIconIndex >= 0 && startServerIndex >= 0 && trayIconIndex < startServerIndex).toBe(true);
  });

  // Dynamic-port + instance-pointer wiring (matches RepoYeti's tray): the tray must read the
  // runtime.json pointer the daemon writes and validate it via /api/health before trusting it,
  // rather than assuming the preferred port is where the daemon actually landed.
  it("reads the runtime pointer and validates it via /api/health before trusting it", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/REDESIGN_HOME/.test(tray)).toBe(true);
    expect(/runtime\.json/i.test(tray)).toBe(true);
    expect(/function\s+Get-RunningUrl/i.test(tray)).toBe(true);
    expect(/function\s+Test-ReDesign/i.test(tray)).toBe(true);
    expect(/\/api\/health/i.test(tray)).toBe(true);
    expect(/service\s+-eq\s+["']redesign["']/i.test(tray)).toBe(true);

    // Open/menu actions and the initial browser open resolve through $script:url (kept in sync
    // with Get-RunningUrl / Wait-ForUrl), not a hardcoded preferred-port URL.
    expect(/Start-Process\s+\$script:url/i.test(tray)).toBe(true);
    expect(/function\s+Wait-ForUrl/i.test(tray)).toBe(true);
  });

  // The headless self-test (-SelfTest) mirrors RepoYeti's: bun on PATH, the daemon entry file
  // exists, and the icon loads into a real NotifyIcon, with no browser/mutex/message-loop work.
  it("declares a -SelfTest switch, gated before any tray/mutex/daemon work", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/\[switch\]\$SelfTest/i.test(tray)).toBe(true);
    expect(/REDESIGN_TRAY_SELFTEST_OK/.test(tray)).toBe(true);
    expect(/REDESIGN_TRAY_SELFTEST_FAIL/.test(tray)).toBe(true);

    const selfTestIndex = tray.search(/if\s*\(\s*\$SelfTest\s*\)/i);
    const mutexIndex = tray.search(/New-Object\s+System\.Threading\.Mutex/i);
    expect(selfTestIndex >= 0 && mutexIndex >= 0 && selfTestIndex < mutexIndex).toBe(true);
  });

  it("-SelfTest actually runs and reports OK on this machine", () => {
    let out = "";
    let failed = false;
    try {
      out = cp.execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", trayPath, "-SelfTest"],
        { encoding: "utf8" },
      );
    } catch (e) {
      failed = true;
      out = (e as { stdout?: string })?.stdout || "";
    }
    expect(failed).toBe(false);
    expect(out).toContain("REDESIGN_TRAY_SELFTEST_OK");
  });

  it("resolves the .lnk for real and confirms it points at THIS repo", () => {
    if (!fs.existsSync(lnkPath)) return;

    let link: { TargetPath?: string; Arguments?: string; WorkingDirectory?: string; IconLocation?: string } | null = null;
    try {
      // WScript.Shell.CreateShortcut() reads the .lnk through an ANSI path, so a
      // Unicode filename (the macron in "RēDesign.lnk") silently yields empty
      // properties, same limitation Create-Shortcut.ps1 documents for the write
      // side. (NTFS 8.3 short names are disabled on this volume, so there's no
      // ASCII alias to resolve to.) Work around it the same way Create-Shortcut.ps1
      // does: copy the .lnk to a temp pure-ASCII filename, read through that, then
      // clean up, the copy is byte-identical, so the properties are unaffected.
      const ps =
        "$tmp=Join-Path $env:TEMP ('lnkread_' + [guid]::NewGuid().ToString('N') + '.lnk');" +
        "Copy-Item -LiteralPath '" + lnkPath + "' -Destination $tmp;" +
        "try {" +
        "$ws=New-Object -ComObject WScript.Shell;" +
        "$s=$ws.CreateShortcut($tmp);" +
        "[pscustomobject]@{TargetPath=$s.TargetPath;Arguments=$s.Arguments;" +
        "WorkingDirectory=$s.WorkingDirectory;IconLocation=$s.IconLocation}|ConvertTo-Json -Compress" +
        "} finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }";
      const out = cp.execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
      link = JSON.parse(out.trim());
    } catch (_) {
      link = null;
    }
    expect(link).toBeTruthy();
    if (!link) return;

    expect(/wscript\.exe$/i.test((link.TargetPath || "").trim()) && fs.existsSync(link.TargetPath!)).toBe(true);
    expect(samePath(link.Arguments, vbsPath)).toBe(true);
    expect(samePath(link.WorkingDirectory, repoRoot)).toBe(true);
    expect(samePath((link.IconLocation || "").replace(/,\d+$/, ""), icoPath)).toBe(true);
  });

  it("the tray icon file loads as a real icon", () => {
    if (!fs.existsSync(lnkPath) || !fs.existsSync(icoPath)) return;
    let iconOk = false;
    try {
      const ps2 =
        "Add-Type -AssemblyName System.Drawing;" +
        "try{$i=New-Object System.Drawing.Icon('" + icoPath + "');if($i){'OK'}}catch{'FAIL:'+$_.Exception.Message}";
      iconOk = /OK/.test(cp.execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps2], { encoding: "utf8" }));
    } catch (_) {
      iconOk = false;
    }
    expect(iconOk).toBe(true);
  });
});

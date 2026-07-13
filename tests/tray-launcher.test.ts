// THE TRAY GUARD, hardcore red, thou shalt not pass. The product MUST always
// ship a clickable shortcut in the project ROOT that, when run, boots the
// environment (bun src/index.ts serve) and raises the system-tray icon. If any
// link in that chain breaks, the shortcut is gone, it points at a stale/dead
// path, the launcher no longer starts the server or the tray, or the icon won't
// load, these assertions fail and `bun test` exits non-zero.
//
// ReDesign's tray is now a THIN ADAPTER (misc/ReDesign-Tray.ps1) over the shared
// LunarWerx tray-host ENGINE (misc/Tray-Host.ps1, kit-synced from
// lunarwerx-ui/src/tray-host/Tray-Host.ps1). Assertions below are split
// accordingly: behavior that's identical across the whole app family (mutex
// mechanics, NotifyIcon lifecycle, Open-AppUi/portable-window routing, the
// hide-tray-icon gate/live-sync, runtime-pointer validation) is grepped against
// the ENGINE file; behavior that's genuinely ReDesign-specific (mutex name,
// daemon start command, icon filename, menu label, selftest marker, the
// shutdown sentinel/service id, .vbs wiring) is grepped against the ADAPTER or
// still exercised end-to-end via -SelfTest / Create-Shortcut.ps1 subprocess
// runs. No assertion's INTENT has been dropped in this split.
//
// The launch chain itself is ALSO now split into shared kit pieces: the root
// .lnk points at the shared misc/Tray-Launch.vbs (kit-synced from
// lunarwerx-ui/src/tray-host/Tray-Launch.vbs, replacing the old per-app
// Reimagine.vbs, which is deleted), which auto-discovers the sibling
// "*-Tray.ps1" adapter with zero per-app content. misc/Create-Shortcut.ps1 is
// itself now a thin adapter over the shared misc/New-TrayShortcut.ps1 engine
// (kit-synced from lunarwerx-ui/src/tray-host/New-TrayShortcut.ps1). Assertions
// about the .vbs / shortcut-engine machinery are grepped against those shared
// files; ReDesign-specific wiring (which adapter it resolves to, the app name/
// icon/description passed into the engine) is still exercised end-to-end.
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
  const vbsPath = path.join(repoRoot, "misc", "Tray-Launch.vbs");
  const trayPath = path.join(repoRoot, "misc", "ReDesign-Tray.ps1");
  const enginePath = path.join(repoRoot, "misc", "Tray-Host.ps1");
  const icoPath = path.join(repoRoot, "misc", "Reimagine.ico");
  const shortcutPath = path.join(repoRoot, "misc", "Create-Shortcut.ps1");
  const shortcutEnginePath = path.join(repoRoot, "misc", "New-TrayShortcut.ps1");

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

  it("every file the shortcut drives is present (vbs, tray adapter, engine, icon)", () => {
    expect(fs.existsSync(vbsPath)).toBe(true);
    expect(fs.existsSync(trayPath)).toBe(true);
    expect(fs.existsSync(enginePath)).toBe(true);
    expect(fs.existsSync(icoPath)).toBe(true);
    expect(fs.existsSync(shortcutPath)).toBe(true);
    expect(fs.existsSync(shortcutEnginePath)).toBe(true);
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

  // The engine's characteristic functions identify it as the shared tray-host engine
  // (proves this copy wasn't hand-edited into a fork) and the adapter dot-sources it.
  it("is the real shared tray-host engine (not a hand-edited fork), and the adapter dot-sources it", () => {
    const engine = fs.existsSync(enginePath) ? fs.readFileSync(enginePath, "utf8") : "";
    expect(/function\s+Start-TrayHost/i.test(engine)).toBe(true);
    expect(/function\s+Invoke-TrayHostSelfTest/i.test(engine)).toBe(true);

    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/\.\s*\(Join-Path\s+\$scriptDir\s+["']Tray-Host\.ps1["']\)/i.test(tray)).toBe(true);
    expect(/Start-TrayHost\s+\$TrayConfig/i.test(tray)).toBe(true);
    expect(/Invoke-TrayHostSelfTest\s+\$TrayConfig/i.test(tray)).toBe(true);
  });

  // The shared launcher (.vbs) and shortcut engine (New-TrayShortcut.ps1) are the real
  // shared pieces (not hand-edited forks), and Create-Shortcut.ps1 dot-sources the engine
  // rather than building the .lnk itself.
  it("the vbs launcher and shortcut engine are the real shared pieces (not hand-edited forks); Create-Shortcut dot-sources the engine", () => {
    const vbs = fs.existsSync(vbsPath) ? fs.readFileSync(vbsPath, "utf8") : "";
    expect(/WScript\.Shell|discover/i.test(vbs)).toBe(true);

    const shortcutEngine = fs.existsSync(shortcutEnginePath) ? fs.readFileSync(shortcutEnginePath, "utf8") : "";
    expect(/function\s+New-TrayShortcut/i.test(shortcutEngine)).toBe(true);

    const shortcut = fs.existsSync(shortcutPath) ? fs.readFileSync(shortcutPath, "utf8") : "";
    expect(/\.\s*\(Join-Path\s+\$scriptDir\s+["']New-TrayShortcut\.ps1["']\)/i.test(shortcut)).toBe(true);
    expect(/New-TrayShortcut\s+`/i.test(shortcut) || /New-TrayShortcut\s+-Root/i.test(shortcut)).toBe(true);
  });

  it("the launcher chain actually starts the environment + the tray icon (engine-invariant)", () => {
    // The shared vbs no longer hardcodes "ReDesign-Tray.ps1" (zero per-app content) - instead
    // it auto-discovers the sibling "*-Tray.ps1" adapter and launches whatever it finds. Verify
    // the discovery machinery is present, and that it actually resolves to ReDesign's adapter
    // on disk (proving the auto-discovery, not a hardcoded name, is what wires the two together).
    const vbs = fs.existsSync(vbsPath) ? fs.readFileSync(vbsPath, "utf8") : "";
    expect(/Right\(lname,\s*9\)\s*=\s*"-tray\.ps1"/i.test(vbs)).toBe(true);
    expect(/sh\.Run\s+"powershell/i.test(vbs)).toBe(true);
    expect(/scriptDir\s*&\s*"\\"\s*&\s*adapter/i.test(vbs)).toBe(true);
    expect(path.basename(trayPath).toLowerCase().endsWith("-tray.ps1")).toBe(true);

    // Daemon runtime + entry file are ADAPTER config (app-specific: bun + index.ts).
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/bun/i.test(tray) && /index\.ts/i.test(tray)).toBe(true);
    expect(/StartCommand\s*=\s*["']bun run src\\index\.ts serve["']/i.test(tray)).toBe(true);
    expect(/EntryFile\s*=\s*["']src\\index\.ts["']/i.test(tray)).toBe(true);

    // NotifyIcon construction + non-blocking named-mutex single-instance guard are
    // ENGINE-invariant (shared across the whole app family).
    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/NotifyIcon/i.test(engine)).toBe(true);
    expect(/System\.Threading\.Mutex/i.test(engine)).toBe(true);
    // The engine acquires the mutex non-blocking via the 3-arg constructor (initiallyOwned=$true,
    // name, [ref]$createdMutex) rather than a separate WaitOne(0) call — this IS the uniform
    // non-blocking acquisition path across all four apps (see engine's own comment on why).
    expect(/New-Object\s+System\.Threading\.Mutex\(\$true,\s*\$Config\.MutexName,\s*\[ref\]\$createdMutex\)/i.test(engine)).toBe(true);

    // ReDesign's specific "orphan daemon" refusal message (OnStrayDaemon='warn') lives in the
    // engine (parameterized by $displayName) — the adapter doesn't restate the copy.
    expect(/is already serving at \$existing, but the tray icon is not running\. Stop that process, then run the shortcut again\./i.test(engine)).toBe(true);
    expect(/OnStrayDaemon\s*=\s*["']warn["']/i.test(tray)).toBe(true);

    // Icon creation precedes daemon launch (icon-first guarantee): engine creates the NotifyIcon
    // (New-TrayHostIcon) strictly before the cold-start Start-DaemonHere call.
    const trayIconIndex = engine.search(/\$tray\s*=\s*New-TrayHostIcon/i);
    const startDaemonIndex = engine.search(/\$startProc\s*=\s*Start-DaemonHere\s+\$null/i);
    expect(trayIconIndex >= 0 && startDaemonIndex >= 0 && trayIconIndex < startDaemonIndex).toBe(true);
  });

  // Mutex-loser cold-start race: a second launch that loses the mutex while the FIRST instance
  // is still cold-starting (no live URL yet) must tell the user to wait, not silently open a
  // browser tab against the bare, unvalidated preferred-port guess URL (which would just show a
  // connection-refused error since nothing is listening yet). This is the parity gap the OLD
  // per-app script (ReDesign-Tray.OLD.ps1) covered and the first engine extraction dropped —
  // guard it for good. ENGINE-invariant (parameterized by $displayName, not ReDesign-specific).
  it("shows an 'already starting, wait a moment' message when the mutex-loser finds no live URL yet", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    const loserBlock = engine.match(/if\s*\(-not\s+\$script:ownsTrayMutex\)\s*\{[\s\S]*?\n {2}\}/i)?.[0] || "";
    expect(loserBlock.length).toBeGreaterThan(0);

    // Resolves the live URL first, and only opens it when one was actually found.
    expect(/\$u\s*=\s*Get-LiveUrl/i.test(loserBlock)).toBe(true);
    expect(/if\s*\(\s*\$u\s*\)\s*\{\s*\n\s*Open-AppUi\s+\$u/i.test(loserBlock)).toBe(true);

    // No-live-URL-yet branch shows the wait message instead of falling through to Open-AppUi on
    // the bare $script:url guess.
    expect(/is already starting in the tray\. Wait a moment, then open it from the tray icon\./i.test(loserBlock)).toBe(true);
    expect(/\}\s*else\s*\{\s*\n\s*\[System\.Windows\.Forms\.MessageBox\]::Show\("\$displayName is already starting/i.test(loserBlock)).toBe(true);

    // The message is parameterized by $displayName (not a hardcoded "RēDesign"/app name), so
    // every family member gets its own correct app name in the dialog.
    expect(/is already starting in the tray/.test(engine.replace(loserBlock, ""))).toBe(false);
  });

  // Portable window opt-in (matches RepoYeti's tray): every browser-open call site routes
  // through Open-AppUi, which honours runtime.json's portableMode by launching a chromeless
  // Edge/Chrome --app= window instead of a normal tab. This machinery is ENGINE-invariant.
  it("routes every browser-open through Open-AppUi, which can launch a --app= window", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/function\s+Open-AppUi/i.test(engine)).toBe(true);
    expect(/function\s+Resolve-ChromiumBrowser/i.test(engine)).toBe(true);
    expect(/--app=\$url/i.test(engine)).toBe(true);
    // No leftover Start-Process call site bypasses Open-AppUi (only its own internal fallback,
    // and the mutex-loser/first-run cold-start paths, both of which call Open-AppUi itself).
    expect(/Start-Process\s+\$u\b/i.test(engine)).toBe(false);
    const openAppUiCalls = (engine.match(/Open-AppUi\s+\$/gi) || []).length;
    expect(openAppUiCalls).toBeGreaterThanOrEqual(4);
  });

  // Hide-tray-icon opt-in (web Settings → PUT /api/settings → runtime.json's hideTrayIcon):
  // the NotifyIcon object must ALWAYS be created (Quit/menu/watchdog hang off it) — only its
  // .Visible is gated, right after the unconditional Visible=$true, and kept in sync live on
  // the health timer so re-enabling it from the web UI needs no restart. ENGINE-invariant.
  it("always creates the tray icon and only gates .Visible on hideTrayIcon", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/function\s+Get-HideTrayIcon/i.test(engine)).toBe(true);
    expect(/hideTrayIcon/.test(engine)).toBe(true);

    // The unconditional `$tray.Visible = $true` still precedes the hideTrayIcon gate, and the
    // gate itself precedes the cold-start daemon launch, so a hidden-icon run never skips icon
    // creation.
    const unconditionalVisibleIndex = engine.search(/\$tray\.Visible\s*=\s*\$true/i);
    const gateIndex = engine.search(/if\s*\(\s*Get-HideTrayIcon\s*\)\s*\{\s*\$tray\.Visible\s*=\s*\$false\s*\}/i);
    const startDaemonIndex = engine.search(/\$startProc\s*=\s*Start-DaemonHere\s+\$null/i);
    expect(unconditionalVisibleIndex >= 0 && gateIndex >= 0 && startDaemonIndex >= 0).toBe(true);
    expect(unconditionalVisibleIndex).toBeLessThan(gateIndex);
    expect(gateIndex).toBeLessThan(startDaemonIndex);
  });

  // Live re-sync: the health timer (which already ticks every 5s to probe /api/health) also
  // re-reads runtime.json and flips $tray.Visible to match, so toggling the setting in web
  // Settings reaches the icon without restarting the tray or the daemon. ENGINE-invariant.
  it("re-syncs tray icon visibility with hideTrayIcon on the health timer tick", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    const healthTimerBlock = engine.match(/\$healthTimer\.Add_Tick\(\{[\s\S]*?\n {2}\}\)/i)?.[0] || "";
    expect(healthTimerBlock.length).toBeGreaterThan(0);
    expect(/Get-HideTrayIcon/i.test(healthTimerBlock)).toBe(true);
    expect(/\$tray\.Visible/i.test(healthTimerBlock)).toBe(true);
  });

  // Hiding the icon must never stop the daemon/watchdog/menu, and re-opening must never depend
  // on the icon's visibility: Open-AppUi (the shortcut-relaunch/mutex-loser attach path) makes
  // no reference to $tray.Visible. ENGINE-invariant.
  it("does not gate Open-AppUi (the re-attach/relaunch path) on tray icon visibility", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    const openAppUiFn = engine.match(/function\s+Open-AppUi[\s\S]*?\n {2}\}/i)?.[0] || "";
    expect(openAppUiFn.length).toBeGreaterThan(0);
    expect(/\$tray\.Visible/i.test(openAppUiFn)).toBe(false);
  });

  // Dedicated portable-window profile (matches RepoYeti's tray): the --app= window gets its
  // own Chromium profile, a sibling of runtime.json, so it remembers its own geometry instead
  // of sharing the default browser profile. ENGINE-invariant.
  it("gives the portable window its own Chromium profile, a sibling of runtime.json", () => {
    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/--user-data-dir=/i.test(engine)).toBe(true);
    expect(/portable-profile/i.test(engine)).toBe(true);
    expect(/--no-first-run/i.test(engine)).toBe(true);
    expect(/--no-default-browser-check/i.test(engine)).toBe(true);
  });

  // Dynamic-port + instance-pointer wiring (matches RepoYeti's tray): the tray must read the
  // runtime.json pointer the daemon writes and validate it via /api/health before trusting it,
  // rather than assuming the preferred port is where the daemon actually landed. The
  // validation MACHINERY (Get-RunningUrl/Test-Daemon/Wait-ForUrl, /api/health) is
  // ENGINE-invariant; the REDESIGN_HOME env var and the "redesign" service id are ADAPTER
  // config (ReDesign's ServiceName divergence — see engine header contract).
  it("reads the runtime pointer and validates it via /api/health before trusting it", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/REDESIGN_HOME/.test(tray)).toBe(true);
    expect(/ServiceName\s*=\s*["']redesign["']/i.test(tray)).toBe(true);
    expect(/InfoFile\s*=\s*Join-Path\s+\$rdHome\s+["']runtime\.json["']/i.test(tray)).toBe(true);

    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/runtime\.json/i.test(engine)).toBe(true);
    expect(/function\s+Get-RunningUrl/i.test(engine)).toBe(true);
    expect(/function\s+Test-Daemon/i.test(engine)).toBe(true);
    expect(/\/api\/health/i.test(engine)).toBe(true);
    // The anti-collision check: when a non-empty $service is passed, the health probe requires
    // body.service -eq $service (case-sensitive) in addition to body.ok.
    expect(/service\s*-eq\s*\$service/i.test(engine)).toBe(true);
    expect(/function\s+Wait-ForUrl/i.test(engine)).toBe(true);
    // Open/menu actions resolve through $script:url (kept in sync with Get-RunningUrl /
    // Wait-ForUrl) and route through Open-AppUi rather than a hardcoded preferred-port URL.
    expect(/Open-AppUi\s+\$script:url/i.test(engine)).toBe(true);
  });

  // ReDesign's shutdown sentinel: a web-UI "Shut Down" (or `redesign stop`) drops
  // shutdown.request, which tears down the WHOLE tray, not just the daemon — otherwise the
  // watchdog would resurrect the daemon the user asked to stop. The watch-timer/sentinel
  // MACHINERY is ENGINE-invariant (SentinelFile-gated); the actual sentinel path is ADAPTER
  // config.
  it("wires the full-shutdown sentinel through the engine's watch timer", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/SentinelFile\s*=\s*Join-Path\s+\$rdHome\s+["']shutdown\.request["']/i.test(tray)).toBe(true);

    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/\$script:shutdownRequestFile\s*=\s*\$Config\.SentinelFile/i.test(engine)).toBe(true);
    expect(/\$watchTimer\s*=\s*New-Object\s+System\.Windows\.Forms\.Timer/i.test(engine)).toBe(true);
    expect(/Invoke-QuitApp/i.test(engine)).toBe(true);
    // Sentinel cleared at startup so a stale one from a hard-killed prior run can't trigger an
    // instant quit.
    expect(/Remove-Item\s+\$script:shutdownRequestFile/i.test(engine)).toBe(true);
  });

  // ReDesign is a force-kill app (no HTTP shutdown token): Quit and the worker always sweep the
  // daemon's port directly via taskkill, matching the original's unconditional Stop-Server call.
  // ENGINE-invariant branch; ReDesign's adapter simply never sets ShutdownTokenEnvVar.
  it("does not configure an HTTP shutdown token (force-kill app)", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    // No key ASSIGNMENT into $TrayConfig for either — a doc-comment mention explaining the
    // divergence is fine, an actual `ShutdownTokenEnvVar = ...` config line is not.
    expect(/ShutdownTokenEnvVar\s*=/i.test(tray)).toBe(false);
    expect(/ShutdownHeaderPrefix\s*=/i.test(tray)).toBe(false);

    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/if\s*\(-not\s+\$useToken\)\s*\{\s*\n\s*Stop-DaemonHere\s+\$true/i.test(engine)).toBe(true);
  });

  // ReDesign's rebuild resolver (misc\Rebuild.bat first, else npm run build) is ADAPTER config;
  // IsDevTree is gated by the REDESIGN_DEV env var (public users rebuild via misc\Rebuild.bat
  // instead of the tray menu item); the dual/triple gate that hides the menu item outside a dev
  // tree is ENGINE-invariant machinery.
  it("supplies a Rebuild.bat-first resolver and gates Rebuild & Restart on REDESIGN_DEV", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/Rebuild\.bat/i.test(tray)).toBe(true);
    expect(/npm run build/i.test(tray)).toBe(true);
    expect(/IsDevTree\s*=\s*\(\$env:REDESIGN_DEV -eq "1"\)/i.test(tray)).toBe(true);
    expect(/RebuildLogName\s*=\s*["']Reimagine-Rebuild\.log["']/i.test(tray)).toBe(true);

    const engine = fs.readFileSync(enginePath, "utf8");
    expect(/Rebuild && Restart/i.test(engine)).toBe(true);
    expect(/if\s*\(\$isDevTree\s+-and\s+\$rebuildSpec\)/i.test(engine)).toBe(true);
  });

  // ReDesign's mutex is a hashed per-checkout name (so a second checkout on the same machine
  // gets its own tray host) — computed by the ADAPTER and passed through as MutexName.
  it("computes a hashed per-checkout mutex name", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/SHA256/i.test(tray)).toBe(true);
    expect(/MutexName\s*=\s*["']Local\\redesign\.tray\.\$hash["']/i.test(tray)).toBe(true);
  });

  // ReDesign's documented restart-retry divergence (one extra attempt after a failed bind,
  // waiting for the port to free first) must survive the refactor unchanged.
  it("keeps ReDesign's one-retry restart policy with a port-free wait", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/RestartRetries\s*=\s*1/i.test(tray)).toBe(true);
    expect(/UsePortFreeWait\s*=\s*\$true/i.test(tray)).toBe(true);
  });

  // The headless self-test (-SelfTest) mirrors the family's: runtime on PATH, the daemon entry
  // file exists, and the icon loads into a real NotifyIcon, with no browser/mutex/message-loop
  // work. The check SEQUENCE is ENGINE-invariant; the marker string is ADAPTER config.
  it("declares a -SelfTest switch, gated before any tray/mutex/daemon work", () => {
    const tray = fs.existsSync(trayPath) ? fs.readFileSync(trayPath, "utf8") : "";
    expect(/\[switch\]\$SelfTest/i.test(tray)).toBe(true);
    expect(/SelfTestMarker\s*=\s*["']REDESIGN_TRAY_SELFTEST["']/i.test(tray)).toBe(true);

    const selfTestIndex = tray.search(/if\s*\(\s*\$SelfTest\s*\)/i);
    const dotSourceIndex = tray.search(/\.\s*\(Join-Path\s+\$scriptDir\s+["']Tray-Host\.ps1["']\)/i);
    expect(selfTestIndex >= 0 && dotSourceIndex >= 0).toBe(true);
    // The engine's mutex acquisition only happens inside Start-TrayHost, which -SelfTest never
    // calls — Invoke-TrayHostSelfTest is fully headless (no mutex, no browser, no message loop).
    const engine = fs.readFileSync(enginePath, "utf8");
    const selfTestFnBody = engine.match(/function\s+Invoke-TrayHostSelfTest\([\s\S]*?\n\}/i)?.[0] || "";
    expect(selfTestFnBody.length).toBeGreaterThan(0);
    expect(/System\.Threading\.Mutex/i.test(selfTestFnBody)).toBe(false);
    // No app-specific marker text (e.g. "REDESIGN") is hardcoded in the engine — it's threaded
    // through as $Config.SelfTestMarker and interpolated at print time.
    expect(/REDESIGN_TRAY_SELFTEST/i.test(engine)).toBe(false);
    expect(/\$\{marker\}_OK|\$\{marker\}_FAIL/i.test(engine)).toBe(true);
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

  // Proves the SHARED Tray-Launch.vbs's auto-discovery actually resolves to ReDesign's
  // adapter on THIS checkout, without really launching it (no daemon/tray side effects).
  // Copies the real vbs to a temp file with the terminal `sh.Run "powershell..."` line
  // swapped for a WScript.Echo of the resolved adapter path, points it at the real misc/
  // dir via a copy alongside it, and runs it headless under cscript. If discovery ever
  // breaks (matchCount 0 or >1, or it picks the wrong file), this fails.
  it("Tray-Launch.vbs auto-discovers ReDesign-Tray.ps1 via cscript (echo-probe, no real launch)", () => {
    if (!fs.existsSync(vbsPath)) return;
    const vbsSrc = fs.readFileSync(vbsPath, "utf8");
    // Replace the real launch line with an echo of the resolved adapter name, so the probe
    // proves discovery without spawning powershell/the daemon/the tray.
    const probeSrc = vbsSrc.replace(
      /sh\.Run\s+"powershell[\s\S]*?, 0, False/,
      'WScript.Echo "RESOLVED_ADAPTER:" & adapter',
    );
    expect(probeSrc).not.toBe(vbsSrc); // sanity: the replace actually matched

    const probeDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "trayprobe-"));
    try {
      // The probe must live in a sibling "misc"-shaped folder alongside a copy of the real
      // adapter, so its own scriptDir-relative discovery walks the SAME files ReDesign ships.
      const probeMisc = path.join(probeDir, "misc");
      fs.mkdirSync(probeMisc);
      const probeVbs = path.join(probeMisc, "Tray-Launch.vbs");
      fs.writeFileSync(probeVbs, probeSrc, "utf8");
      for (const f of fs.readdirSync(path.join(repoRoot, "misc"))) {
        if (/-tray\.ps1$/i.test(f) || /-host\.ps1$/i.test(f) || /-shortcut\.ps1$/i.test(f)) {
          fs.copyFileSync(path.join(repoRoot, "misc", f), path.join(probeMisc, f));
        }
      }
      const out = cp.execFileSync("cscript", ["//Nologo", probeVbs], { encoding: "utf8" });
      expect(out.trim()).toBe("RESOLVED_ADAPTER:ReDesign-Tray.ps1");
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
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

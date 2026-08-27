import { test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import {
  SETTINGS_FILE,
  loadAppSettings,
  resetAppSettingsCache,
  saveAppSettings,
} from "../src/app-settings";

// Happy-path persistence for the portableMode opt-in (see src/http/routes/settings.ts's PUT
// /api/settings handler, which is the only writer in normal operation). Snapshots and restores
// output/.reimagine-settings.json (gitignored, local-only) so this test never leaves the repo's
// working tree dirty, matching the module's own module-level cache reset via a fresh load.
const existed = fs.existsSync(SETTINGS_FILE);
const before = existed ? fs.readFileSync(SETTINGS_FILE, "utf8") : null;

afterEach(() => {
  if (before !== null) {
    fs.writeFileSync(SETTINGS_FILE, before);
  } else if (fs.existsSync(SETTINGS_FILE)) {
    fs.rmSync(SETTINGS_FILE, { force: true });
  }
});

// Every case below asserts a DEFAULT first, so each must start from "no file on disk" — the
// ambient local file may legitimately carry explicit opt-ins (that is what it exists for), and
// reading it would test this machine's choices instead of the module's defaults. The snapshot
// above puts the real file back afterwards.
beforeEach(() => {
  if (fs.existsSync(SETTINGS_FILE)) fs.rmSync(SETTINGS_FILE, { force: true });
  // Deleting the file is NOT enough on its own: app-settings.ts memoizes the parsed settings, and
  // `bun test` shares one module instance across every file in the run. Without this reset, a
  // sibling test file that loaded settings first leaves its values in that cache and every
  // "default" assertion below reads them instead of the defaults.
  resetAppSettingsCache();
});

test("portableMode persists through save + reload (default off)", () => {
  const settings = loadAppSettings();
  expect(settings.portableMode).not.toBe(true);

  settings.portableMode = true;
  saveAppSettings(settings);

  const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  expect(onDisk.portableMode).toBe(true);
});

test("hideTrayIcon persists through save + reload (default off)", () => {
  const settings = loadAppSettings();
  expect(settings.hideTrayIcon).not.toBe(true);

  settings.hideTrayIcon = true;
  saveAppSettings(settings);

  const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  expect(onDisk.hideTrayIcon).toBe(true);
});

// Unified auto-update policy (2026-08-11): autoUpdate flipped to off-by-default (only an explicit
// `true` opts into silent installs), updateNotify is new and on-by-default. See src/auto-update.ts
// for how absent reads as "notify-only", and src/http/app.ts's createApp() for where these exact
// expressions (`=== true` / `!== false`) are applied at boot.
test("autoUpdate persists through save + reload (default notify-only, not silent-apply)", () => {
  const settings = loadAppSettings();
  expect(settings.autoUpdate).not.toBe(true);

  settings.autoUpdate = true;
  saveAppSettings(settings);

  const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  expect(onDisk.autoUpdate).toBe(true);
});

test("updateNotify persists through save + reload (default on)", () => {
  const settings = loadAppSettings();
  expect(settings.updateNotify).not.toBe(false);

  settings.updateNotify = false;
  saveAppSettings(settings);

  const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  expect(onDisk.updateNotify).toBe(false);
});

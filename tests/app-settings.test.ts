import { test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import { SETTINGS_FILE, loadAppSettings, saveAppSettings } from "../src/app-settings";

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

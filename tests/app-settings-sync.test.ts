/**
 * What travels to a Connections account, and what must not.
 *
 * `src/connections.ts` syncs `{ appearance, prefs }`; this covers the `prefs` half — the daemon
 * preference allowlist added 2026-08-25. Until then the file synced only the browser's theme, on
 * the stated grounds that theme was the app's only portable preference, which stopped being true
 * as soon as `app-settings.ts` existed and nobody noticed for months.
 *
 * The allowlist logic is pure, so it is tested directly rather than through a mocked OAuth round
 * trip: these assertions are about WHICH keys move, and a transport mock would only make that
 * harder to read.
 */
import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import {
  SETTINGS_FILE,
  SYNCED_PREF_KEYS,
  NEVER_SYNCED_PREF_KEYS,
  applySyncedPrefs,
  loadAppSettings,
  readSyncedPrefs,
  resetAppSettingsCache,
  saveAppSettings,
  type AppSettings,
} from "../src/app-settings";

// The settings file is the developer's real one — save it and put it back rather than leaving
// this suite's fixture behind on the machine that ran it.
const had = fs.existsSync(SETTINGS_FILE);
const original = had ? fs.readFileSync(SETTINGS_FILE, "utf8") : null;

/** Every preference set to a non-default value, so nothing below can pass by coincidence. */
const ALL: Required<AppSettings> = {
  autoUpdate: true,
  updateNotify: false,
  autoUpdateIntervalSecs: 43_200,
  portableMode: true,
  hideTrayIcon: true,
  outputRetentionDays: 7,
};

beforeEach(() => {
  saveAppSettings({ ...ALL });
});

afterAll(() => {
  if (original !== null) fs.writeFileSync(SETTINGS_FILE, original);
  else fs.rmSync(SETTINGS_FILE, { force: true });
  // Putting the bytes back is only half of it: `app-settings.ts` memoizes the parsed settings and
  // `bun test` shares one module instance across the whole run, so this file's fixture would
  // otherwise stay live in that cache for every test file that runs after it.
  resetAppSettingsCache();
});

test("the two lists partition AppSettings and never overlap", () => {
  // The compile-time guard in app-settings.ts already proves coverage; this proves the other
  // half — that no key is on BOTH lists, which the type check cannot see and which would
  // silently make an exclusion meaningless.
  const both = (SYNCED_PREF_KEYS as readonly string[]).filter((k) =>
    (NEVER_SYNCED_PREF_KEYS as readonly string[]).includes(k),
  );
  expect(both).toEqual([]);
  const total = SYNCED_PREF_KEYS.length + NEVER_SYNCED_PREF_KEYS.length;
  expect(Object.keys(ALL).length).toBe(total);
});

test("only allowlisted preferences leave the machine", () => {
  const sent = readSyncedPrefs();
  expect(Object.keys(sent).sort()).toEqual([...SYNCED_PREF_KEYS].sort());
  expect(sent.updateNotify).toBe(false);
  expect(sent.autoUpdateIntervalSecs).toBe(43_200);
  // The two that must never travel, checked by name AND by scanning the serialized payload —
  // the second catches a future nesting change that the first would sail straight past.
  expect(sent.autoUpdate).toBeUndefined();
  expect(sent.outputRetentionDays).toBeUndefined();
  const raw = JSON.stringify(sent);
  expect(raw).not.toContain('autoUpdate"');
  expect(raw).not.toContain("outputRetentionDays");
});

test("an incoming doc cannot switch on unattended updating or timed deletion of runs", () => {
  // This is the direction that actually matters. A doc written by a newer build, or tampered
  // with, names whatever it likes; the allowlist on the way IN is what makes that harmless.
  const changed = applySyncedPrefs({
    updateNotify: true, // allowlisted: should land
    portableMode: false, // allowlisted: should land
    autoUpdate: true, // excluded: pulls, rebuilds and RESTARTS the daemon unattended
    outputRetentionDays: 1, // excluded: deletes the owner's finished runs on a timer
    somethingInvented: "x", // not a setting at all
  });

  expect(changed).toBe(true);
  const after = loadAppSettings();
  expect(after.updateNotify).toBe(true);
  expect(after.portableMode).toBe(false);
  // Unchanged from the fixture, i.e. the remote doc did not get to touch them.
  expect(after.autoUpdate).toBe(true);
  expect(after.outputRetentionDays).toBe(7);
  expect((after as Record<string, unknown>).somethingInvented).toBeUndefined();
});

test("applying nothing new reports no change, so a pull cannot churn the settings file", () => {
  expect(applySyncedPrefs({ updateNotify: ALL.updateNotify })).toBe(false);
  expect(applySyncedPrefs({})).toBe(false);
  expect(applySyncedPrefs(undefined)).toBe(false);
  expect(applySyncedPrefs("not an object")).toBe(false);
  expect(applySyncedPrefs(null)).toBe(false);
});

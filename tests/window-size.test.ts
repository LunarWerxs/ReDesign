// The window-size hint: how a portable window learns its intended size when Chromium won't
// apply one from outside. --window-size and even the saved placement are IGNORED when a
// Chromium instance on the profile is already running — the forwarded --app launch inherits
// the existing window's geometry (verified Edge 150, 2026-07-16). So the daemon appends
// WINDOW_SIZE_HINT_PARAM to the URL (http/routes/settings.ts) and the page resizes itself
// (src/web/src/lib/window-size-hint.ts). These tests pin the daemon's halves: the hint
// format, the profile reader, and windowSizeHintFor's remembered/first-run/maximized decision.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  formatWindowSizeHint,
  rememberedPlacement,
  WINDOW_SIZE_HINT_PARAM,
  windowSizeHintFor,
} from "../src/window-size";

const DASH = "http://localhost:5178/";
const INITIAL = { width: 840, height: 760 };

/** A scratch profile whose Preferences hold the given app_window_placement dict. */
function profileWith(placements: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rd-winsize-"));
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(
    join(dir, "Default", "Preferences"),
    JSON.stringify({ browser: { app_window_placement: placements } }),
  );
  return dir;
}

test("hint format is the shape the page's parser accepts", () => {
  expect(formatWindowSizeHint({ width: 840, height: 760 })).toBe("840x760");
  // The web applier parses /^(\d{2,5})x(\d{2,5})$/ — pin the contract both sides share.
  expect(formatWindowSizeHint(INITIAL)).toMatch(/^\d{2,5}x\d{2,5}$/);
  expect(WINDOW_SIZE_HINT_PARAM).toBe("window-size");
});

test("rememberedPlacement reads a flat placement (the Control page's key has no dots)", () => {
  const dir = profileWith({ "localhost_/": { left: 100, top: 50, right: 940, bottom: 810 } });
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 840, height: 760, maximized: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedPlacement rejects junk: degenerate rects, sub-minimum sizes, corrupt prefs", () => {
  const dir = profileWith({ "localhost_/": { left: 100, top: 100, right: 100, bottom: 100 } });
  try {
    expect(rememberedPlacement(dir, DASH)).toBeNull();

    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({
        browser: { app_window_placement: { "localhost_/": { left: 0, top: 0, right: 9, bottom: 900 } } },
      }),
    );
    expect(rememberedPlacement(dir, DASH)).toBeNull();

    writeFileSync(join(dir, "Default", "Preferences"), "{ not json");
    expect(rememberedPlacement(dir, DASH)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberedPlacement carries Chromium's maximized flag (restore bounds)", () => {
  const dir = profileWith({
    "localhost_/": { left: 10, top: 10, right: 850, bottom: 770, maximized: true },
  });
  try {
    expect(rememberedPlacement(dir, DASH)).toEqual({ width: 840, height: 760, maximized: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windowSizeHintFor: remembered beats first-run, junk falls back, maximized sends NO hint", () => {
  const fresh = mkdtempSync(join(tmpdir(), "rd-winsize-"));
  try {
    expect(windowSizeHintFor(fresh, DASH, INITIAL)).toBe("840x760");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }

  const saved = profileWith({ "localhost_/": { left: 0, top: 0, right: 1000, bottom: 900 } });
  try {
    expect(windowSizeHintFor(saved, DASH, INITIAL)).toBe("1000x900");
  } finally {
    rmSync(saved, { recursive: true, force: true });
  }

  const junk = profileWith({ "localhost_/": { left: 5, top: 5, right: 5, bottom: 5 } });
  try {
    expect(windowSizeHintFor(junk, DASH, INITIAL)).toBe("840x760");
  } finally {
    rmSync(junk, { recursive: true, force: true });
  }

  const max = profileWith({
    "localhost_/": { left: 10, top: 10, right: 850, bottom: 770, maximized: true },
  });
  try {
    expect(windowSizeHintFor(max, DASH, INITIAL)).toBeNull();
  } finally {
    rmSync(max, { recursive: true, force: true });
  }
});

// Pins the daemon's first-run portable-window size (PORTABLE_WINDOW_SIZE in
// src/http/routes/settings.ts) the way devwebui pins its DASHBOARD_WINDOW_SIZE: exact
// digits plus the measured intent behind them, so a future tweak has to re-measure rather
// than drift. The tray adapter and misc/Open-Ui.ps1 carry copies of the same numbers —
// tests/tray-launcher.test.ts pins those against these.
import { test, expect } from "bun:test";
import { PORTABLE_WINDOW_SIZE } from "../src/http/routes/settings";

test("the portable window's first-run size fits the measured Control-page layout", () => {
  // Measured against the real Control page (see the constant's comment): the layout caps
  // content at --container-max = 800px, so 800 + 15 scrollbar + ~16 frame = 831 outer is
  // the floor below which the design width gets cropped.
  expect(PORTABLE_WINDOW_SIZE.width).toBe(840);
  expect(PORTABLE_WINDOW_SIZE.height).toBe(760);
  // Guard the intent, not just the digits: it must render the full 800px container…
  expect(PORTABLE_WINDOW_SIZE.width).toBeGreaterThanOrEqual(831);
  // …without drifting back toward Chromium's whole-work-area default.
  expect(PORTABLE_WINDOW_SIZE.width).toBeLessThan(1200);
  expect(PORTABLE_WINDOW_SIZE.height).toBeLessThan(1100);
});

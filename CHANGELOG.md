# Changelog

## Unreleased

- Hop to a free port when the preferred one (default 5178) is held by a foreign process, instead of retrying the same port and dying, matching the sibling apps' loopback-aware probe (`findFreePort`, binds `127.0.0.1` specifically so a squatter on the loopback interface is detected).
- Record the port the daemon actually bound in a runtime pointer at `~/.redesign/runtime.json` (override with `REDESIGN_HOME`), so the CLI, tray, and `start.cmd` can all find the live instance even after a hop.
- Add `GET /api/health` (plain liveness: `{ ok, service: "redesign", ts }`), used by the runtime pointer and the tray to confirm a running instance is actually RēDesign before trusting it.
- `redesign serve`, `redesign status`, and `redesign stop` now resolve the live daemon through the runtime pointer first, falling back to probing the preferred port.
- The auto-update relaunch handoff (`REDESIGN_RELAUNCH=1`) keeps rebinding the exact same port as before, so an open browser tab's bookmarks and SSE connection stay valid across an update.
- Add `REDESIGN_PORT_FIXED=1` as a sibling-parity escape hatch: binds the preferred port exactly, no probing, no hop.
- Tray (`misc/ReDesign-Tray.ps1`): reads the runtime pointer to open/menu-open the URL the daemon actually bound, validated via `/api/health`; add a `-SelfTest` switch (bun on PATH, daemon entry present, tray icon loads into a real NotifyIcon) for headless verification, run before any tray/mutex/daemon work.
- `start.cmd` resolves the URL to open from the runtime pointer, falling back to `http://localhost:5178`.
- Add `check:kit` to catch drift between this app's synced kit files and the shared LunarWerx kit, wired into `npm run check`.

## v1.1.0 - 2026-07-09

- Fix an unauthenticated path-traversal bug in `GET /api/runs/:id` so a crafted run id can no longer escape the runs directory.
- Serve provider defaults from a single `/api/bootstrap` endpoint instead of duplicating them in the web UI.
- Clarify README and privacy wording around what stays local and what the app talks to.
- Extract a shared `resolveInside` guard used everywhere a path is built from user input.
- Cap the run-summary cache at a fixed size so long-running sessions can't grow it unbounded.
- Drop a private internal kit-repo name that had leaked into a few code comments.

## v1.0.1 - 2026-07-06

- Add MIT LICENSE and rewrite the README for open source.
- Update deps to latest, bump CI, declare MIT.
- Sweep AI-tell punctuation and remove every em-dash across the repo.

## v1.0.0 - 2026-07-06

- Initial public release: fan a UI screenshot out to many AI models and compare the redesigns.
- Fix Windows CI, ship a clean sample input, install `src/web` deps in the dist build.
- Detect the compiled binary robustly across platforms.

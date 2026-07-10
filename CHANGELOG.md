# Changelog

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

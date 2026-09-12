# ReDesign

> Sends one UI screenshot to many AI models at once and returns each as a standalone HTML redesign to compare.

<!-- odin:about HAND-OWNED above the GENERATED marker. Edit freely; `odin codex about --ingest` carries it back into Odin's Codex. -->

## What it is

RēDesign is a self-hosted screenshot-to-redesign tool: drop in one UI screenshot, pick a stack of AI models across providers, and it fires them all in parallel to return a gallery of independent, self-contained HTML redesigns placed next to the original. It runs on the user's own machine against API keys they supply (BYOK) and talks to nothing else except the chosen model providers and an optional LunarWerx sync/update endpoint. It is built for comparing many real design directions from many models at once, instead of pasting the same image into one chat tab after another. Ships as a packaged Windows desktop app (plain exe or a tray build) or runs from source on Windows/macOS/Linux via Bun.

## Things not to forget

_The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose
reason lives nowhere else. Odin never overwrites this section._

- Every run first has a vision model describe the screenshot's real content and hands that description to every redesign model, so outputs keep the actual copy and numbers instead of inventing them - this grounding pass is deliberate, not incidental. anchors: `src/runner/reimagine.ts:111`
- Every model-generated HTML redesign is only ever served through a CSP-sandboxed iframe wrapper so it cannot reach the app's own origin or API even if opened directly - this is a security rule, not just a display choice, and must not be relaxed for convenience. anchors: `src/http/fileServing.ts:90`
- Each provider's API keys are pooled and rotated, and a key that starts failing is quietly benched and brought back later rather than killing the whole run - do not simplify this down to a single static key per provider. anchors: `src/keyManager.ts:124`
- Retry only resubmits jobs whose status is failed or skipped; a job that already succeeded cannot be re-rolled for another variant without starting an entirely new run - known gap, not yet built. anchors: `src/http/routes/runs.ts:209`
- The Windows system-tray icon and portable chromeless window mode live in a separate small Rust binary under misc/tray-host-native, not the main app - since 1.6.7 the packaged exe embeds that binary and starts it, so running it by itself does spawn the tray icon. anchors: `misc/tray-host-native/src/daemon.rs:126`
- Models, prompts and pricing are all flat JSON under ~/.redesign/config, seeded on first run and shared verbatim between the packaged app and a from-source checkout - editing those files is the supported way to add or disable a model, no code change needed. anchors: `src/config/shared.ts:296`
- Desktop notifications on run completion only fire when the browser tab is hidden, specifically so a multi-minute fan-out doesn't just raise a toast nobody is looking at. anchors: `src/web/src/stores/control/runs.ts:107`

<!-- odin:about GENERATED BEGIN - rewritten by `odin codex about --publish`; edit the Codex, not this -->

## What Odin knows about this project

Everything from here down is generated from this project's Codex dossier
(`codex/projects/redesign.md` in the Odin clone) and is **rewritten on every publish** -
edit the dossier, not this block. Everything ABOVE the marker is yours.

### At a glance

- **Ships as:** desktop app (Windows) and self-hosted local web app - packaged exe/zip with auto-update from GitHub Releases (plain build or a tray build with a native Rust launcher), or run from source on Windows/macOS/Linux via `bun run src/index.ts serve`
- **Live at:** https://redesign.lunarwerx.com
- **Written in:** TypeScript (218 files), Vue (160 files), JavaScript (14 files), PowerShell (8 files)
- **Built with:** Hono, TypeScript
- **Package:** `redesign` 1.6.6
- **Entry points:** `bin`, `scripts`
- **Tests:** 61 test file(s)
- **CI:** `ci.yml`, `release.yml`
- **Domain:** screenshot-to-code, AI design generation, prompt engineering, self-hosted AI tool, BYOK (bring your own API keys)
- **Remote:** https://github.com/LunarWerxs/ReDesign.git

### Architecture

- `src/http/` - Hono HTTP server: app wiring, static/output file serving through a sandboxed iframe wrapper, SSE run-progress streaming
- `src/http/routes/` - one file per REST route group - runs, models, prompts, keys, inputs, costs, health, settings, updates, connections sync
- `src/runner/` - the batch orchestrator: builds jobs from inputs x models x prompts x variants, schedules them per provider-pool concurrency, runs vision grounding/captioning, and computes cost
- `src/config/` - flat-JSON config store for models, prompts and pricing under ~/.redesign/config, seeded on first run and shared by packaged and from-source runs
- `src/server/` - assembles public-facing model/prompt/key settings responses and handles API key save/delete/bulk-import
- `src/keyManager.ts` - process-wide singleton pooling each provider's API keys, rotating through them and benching ones that start failing
- `src/cli/` - command-line twin of every control-panel action (run, models, keys, prompts, serve/status/stop)
- `src/mcp/` - MCP server (stdio) that proxies the running RēDesign HTTP server as agent tools
- `src/web/` - Vue 3 + Vite + Tailwind + shadcn-vue SPA: control panel, run queue, gallery/viewer, settings stores
- `misc/tray-host-native/` - separate Rust binary providing the Windows system-tray icon, portable chromeless window mode, and daemon lifecycle (start/probe/stop) for the packaged app
- `src/install-ping.ts` - anonymous, opt-out install/usage ping to LunarWerx's Studio endpoint (also used for update checks)

### Features

27 recorded - 27 shipped, 0 partial, 0 planned. Each `path:line` is where the feature is DEFINED, checked by `odin codex check`.

**Shipped**

- **Multi-model parallel redesign fan-out** - Fires one screenshot at every selected model across providers at once and returns each as an independent, self-contained HTML redesign next to the original. - `src/runner/reimagine.ts:320`, `src/runner/scheduling.ts:114`
- **Multiple variants per model in one run** - Ask one model for several independent variants in the same batch so you see a model's range, not just one roll of the dice. - `src/runner/scheduling.ts:50`, `src/http/runQueue.ts:40`
- **Prompt preset library and custom prompt builder** - Ships prompt presets (faithful refresh, bold reimagine, minimalist, conversion, ...) and lets users save custom prompts or compose one from reusable builder options. - `src/config/prompts.ts:234`, `src/config/prompts.ts:271`
- **Reference images for style guidance** - Attach reference images so every model borrows their mood and color palette rather than their layout. - `src/runner/reimagine.ts:29`, `src/http/routes/inputs.ts:16`
- **Automatic screenshot grounding via vision description** - Every run first has a vision model describe the screenshot's real content and hands that description to every redesign model, so outputs keep the real copy and metrics instead of inventing them. - `src/runner/reimagine.ts:111`, `src/runner/helpers.ts:86`
- **Run gallery and viewer** - Browse a run's outputs (or all runs) as a searchable, filterable thumbnail gallery with adjustable column count and phone-through-desktop width preview; stars and hidden outputs persist across a refresh, and the original always sits first. - `src/web/src/stores/viewer.ts:139`
- **Download a run as a zip** - Take an entire run's outputs away as a zip to review offline. - `src/http/routes/runs.ts:103`
- **Retry failed or skipped jobs** - If a model fails or a key cools down mid-run, retry just those jobs instead of paying for the whole fan-out again. - `src/http/routes/runs.ts:157`, `src/http/routes/runs.ts:215`
- **Reload a past run into the control panel** - Any past run can be reloaded into the control panel exactly as it was configured and run again. - `src/web/src/stores/control/run-again.ts:17`
- **Controllable run queue** - Park several batches before spending keys, start them together, add more work behind a live run, and drag waiting batches into the order you want. - `src/http/runQueue.ts:155`, `src/http/runQueue.ts:214`
- **Live run progress over SSE** - The control panel and viewer receive live per-job progress and completion events pushed over server-sent events while a run is in flight. - `src/http/routes/events.ts:13`, `src/http/runQueue.ts:84`
- **Bulk API key import with auto-detected provider** - Paste one key or a whole pile at once; RēDesign works out which provider each belongs to (probing live when ambiguous) and files it into the right pool. - `src/server/settings.ts:276`
- **Per-provider key pools with rotation and health benching** - Each provider can hold a stack of keys; the runner rotates through them and quietly benches ones that start failing, bringing them back later. - `src/keyManager.ts:124`, `src/runner/helpers.ts:41`
- **Model/key health check** - Runs a live probe across configured models and keys and reports which are healthy before you commit a batch. - `src/http/routes/health.ts:25`
- **Run cost meter and pre-run estimate** - Tracks per-run and running-total spend from each provider's usage response, and estimates cost from recent history before you hit Run. - `src/runner/cost.ts:134`, `src/runner/cost.ts:321`
- **Sandboxed HTML preview** - Every model-generated HTML redesign is served through a locked-down CSP-sandboxed iframe wrapper so it can't reach the app's origin or API even if opened directly. - `src/http/fileServing.ts:90`
- **CLI with a command for every UI action** - Every control-panel action - queue a run, list models, manage keys/prompts, check server status - has a command-line twin for scripting. - `src/cli/lifecycle.ts:66`, `src/cli/run.ts:69`
- **MCP server for AI agents** - A built-in MCP server proxies the running RēDesign server so an AI agent can queue and manage runs the same way a human would from the control panel. - `src/mcp/tools.ts:83`, `src/mcp/stdio.ts:15`
- **File-based, code-free configuration** - Models, prompts and pricing live in editable JSON under ~/.redesign/config, seeded on first run and shared by the packaged app and a from-source checkout alike - add or disable a model without touching the app. - `src/config/shared.ts:296`
- **Optional Connections theme sync** - An opt-in "Sync with Connections" toggle carries the UI theme across devices via LunarWerx's Connections service; API keys never leave the machine. - `src/http/routes/connections.ts:46`
- **Self-updating packaged app** - The packaged Windows build checks for and can install newer releases from within the app. - `src/http/routes/updates.ts:9`
- **Desktop notification on run completion** - A multi-minute fan-out raises a native desktop notification when it finishes if the tab is hidden, instead of a toast the user would never see. - `src/web/src/stores/control/runs.ts:107`
- **System tray icon (Windows)** - An optional native tray host (separate small Rust launcher) gives RēDesign a system-tray icon and a portable chromeless window mode; since 1.6.7 the main exe embeds it and starts it, so running the exe alone spawns one too. - `misc/tray-host-native/src/browser.rs:121`, `misc/tray-host-native/src/daemon.rs:126`
- **Brand style guide attachment** - Paste, type, or drop a text file of brand guidelines (separate from image references) that gets folded into every model's prompt, with a persisted default the user can reuse across runs. - `src/web/src/stores/control/state.ts:132`, `src/web/src/composables/useTextAttachments.ts:15`, `src/web/src/components/app/control/BrandStyleGuideBlock.vue:1`
- **Configurable output retention / auto-cleanup** - Set how many days to keep past run outputs on disk (1-3650, or 0 to keep forever); a sweep at daemon startup deletes runs older than the configured window to manage disk usage. - `src/http/routes/settings.ts:118`, `src/http/routes/settings.ts:60`
- **Portable chromeless app window** - Pop the running daemon's own UI open in a dedicated, chromeless Chromium app window (own profile, remembers size/position) instead of a browser tab, toggleable from Settings even outside the tray build. - `src/http/routes/settings.ts:95`, `src/http/routes/settings.ts:37`
- **Per-generation AI observability traces** - Breaks the cost meter's single dollar total into a per-model rollup - call count, error count, average latency, and cost - shown in the Key Health sheet next to the run cost meter, adapted from PostHog's ai_observability product so you can see which model is slow or erroring instead of one folded figure. - `src/runner/cost.ts:505`, `src/http/routes/costs.ts:45`, `src/web/src/components/app/control/key-health-sheet/TraceStats.vue:1`

### Where to add a new one

- **a new HTTP route** - add a route file under src/http/routes/ exporting register(app, deps), following the pattern in an existing route module, then mount it in app.ts anchors: `src/http/app.ts:51`, `src/http/routes/health.ts:25`
- **a new AI provider** - add its id/base URL/key env to the provider table and defaults in src/config/shared.ts so models.ts, the runner and the UI all resolve it anchors: `src/config/shared.ts:171`
- **a new CLI command** - add a handler and register it in the COMMANDS table in src/cli/main.ts; implementation usually lives in src/cli/lifecycle.ts or src/cli/run.ts anchors: `src/cli/main.ts:26`
- **a new MCP tool** - add an entry to the TOOLS table in src/mcp/tools.ts, a thin HTTP-client proxy to the running server's own routes anchors: `src/mcp/tools.ts:83`
- **a new prompt preset or builder option** - use savePromptPreset / upsertPromptBuilderOption in src/config/prompts.ts, which write into ~/.redesign/config/prompts.json anchors: `src/config/prompts.ts:234`, `src/config/prompts.ts:271`
- **a change to how a job is built or executed** - buildJobPrompt / runOneJob in src/runner/job-worker.ts assemble the per-job prompt and drive one model call with key rotation and retry anchors: `src/runner/job-worker.ts:66`, `src/runner/job-worker.ts:323`

### Gaps and wants

_Withheld: this repository is public, and the gap list is not published outside the private index._
_Read it with `python odin.py codex brief redesign` in the Odin clone._

---

_Generated by `odin codex about --publish redesign` on 2026-09-09 from a Codex dossier stamped 2026-09-05. Regenerate after the product moves; `odin codex about` reports drift._
<!-- odin:about GENERATED END sha=9a79840c0716 -->

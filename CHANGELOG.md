# Changelog

## [Unreleased]

### Internal

- **The two image drop zones are one component.** `InputDropzone` (screenshots) and the drop target
  inside `ReferenceBlock` carried a line-for-line copy of the same click / Enter-Space / drag / drop
  / hidden-file-input wiring, and had already drifted: the reference folder chip was a `<code>`
  while the screenshot one was still a `<span class="font-mono">` with an `i18n-ignore` marker it no
  longer needed. Both now render `ImageDropTarget.vue`, which owns `dragOver` and the file input;
  `uploading` stays with the parents because both also upload from paths the element never sees
  (PasteMenu, and InputDropzone's document-level paste listener). Only the duplicated part merged.
  `ReferenceBlock` is a whole panel (switch, tiles, note), not a second dropzone. 118 lines out of
  the two parents for 26 back, and one new test file covering the now-shared wiring.
- **The hidden file input needs `@click.stop`, and browsers hide why.** The tile is itself a click
  target that calls that input's `click()`, so the synthetic click bubbled straight back to the tile
  and reopened the picker, unbounded. Real browsers mask it with the HTML spec's "click in progress"
  flag, so it never showed in the app; happy-dom has no such flag and blew the stack the first time
  a test exercised the keyboard path.
- A literal directory name is a `<code>`, not a `<span class="font-mono">`. `i18n-check.mjs`'s
  `SKIP_TEXT_TAGS` already exempts `<code>`, so each chip drops the `i18n-ignore` marker it used to
  carry, and preflight gives `<code>` the mono family at `font-size: 1em`, so nothing renders
  differently. Verified in-browser: identical computed family, size, weight and line-height.
- `i18n-check.mjs` no longer carries a `new Function` eval. The English catalog is transpiled to a
  throwaway `.mjs` and loaded with a real dynamic `import()`, a truer rehearsal of how the app
  imports it, and a script that gates `npm run build` has no business evaluating source by hand.
- `stores/control/store.ts` (539 lines) split into `types` / `paths` / `summary` / `stale` /
  `manifests` / `retention`, leaving a re-export barrel. The public surface is byte-identical, so no
  consumer changed.

## [1.6.6] - 2026-08-15

### Fixed

- **Quitting from the tray icon while an update is installing no longer leaves you with no app at
  all.** Applying an update starts the replacement daemon and shuts the old one down 800ms later.
  For that fraction of a second the replacement was a CHILD of the daemon on its way out, and the
  tray's Quit does not stop one process, it force-kills a whole process tree, so a Quit landing in
  that window killed both. Neither `detached: true` nor `.unref()` removes a child from its
  parent's tree on Windows, which is exactly why the shared launch helper exists; the relaunch
  simply never used it. Measured directly: with the old spawn the replacement dies to a
  tray-style tree-kill, with the new one it survives.
- **The relaunch now survives Windows throwing away the environment.** That launch helper hands
  the process off to Windows' own process-creation service, which does not pass on environment
  variables, and the port and the "you are the replacement" signal were both environment
  variables. Left as they were, the replacement would have bound a fresh port instead of taking
  over its predecessor's, stranding whatever tab you had open. Both now travel as command-line
  arguments, which that service does deliver, with the environment kept as a fallback for macOS
  and Linux.

## [1.6.5] - 2026-08-15

### Fixed

- **An applied update no longer takes RēDesign down.** On a downloaded release build, installing an
  update stopped the daemon and started nothing in its place. The relaunch built its successor's
  command from `process.argv[0..1]`, which is the runtime and the script in a source checkout but,
  inside a compiled single-file executable, is a placeholder pair pointing at a virtual path that
  exists only inside the running binary. Respawning it fails immediately, and on the machines a
  compiled release exists for (no runtime installed, which is the entire pitch) the command cannot
  resolve at all. Nothing caught it, because the failure is in the child: the spawn call itself
  succeeds, so the guard that exists precisely to never shut down without a successor saw one and
  stepped aside. The update was always written to disk correctly, so an install on an older build
  recovers the moment you start it again, and this is the last time it will need to.
- **An update no longer strands the daemon on a port nobody is releasing.** The successor was handed
  the port this daemon *preferred*, not the one it was actually serving on, and those diverge for
  good the first time anything else holds the preferred port. The relaunch branch binds that port
  directly, with no free-port probe, precisely so it can take over its predecessor's socket; aimed
  at a port a foreign process is sitting on, it simply retried until it gave up, so the update took
  the daemon down permanently rather than handing it over. It now receives the bound port, which is
  the socket actually being freed.

## [1.6.4] - 2026-08-11

### Fixed

- **Tooltips are reachable on a phone.** Reka UI ignores touch pointers on hover, so on a touch-only
  device every tooltip here was dead. Worst of all the info icons: a setting's description lives
  behind that icon and nowhere else, so on mobile the text simply did not exist. Info icons now
  disclose on a single tap and close on a tap outside, a second tap, or a scroll. Every other
  tooltip opens on a press-and-hold, so a plain tap still runs the control's action exactly as
  before, and the click ending a hold is swallowed so nothing fires behind the tooltip. Sliding a
  finger abandons the hold, leaving scrolling alone. Mouse and pen behaviour is untouched: the
  gestures key off the event's own pointer type, not a device media query, so a touchscreen laptop
  keeps hover and merely gains them. From the shared UI kit; reported against RepoYeti as
  [#16](https://github.com/LunarWerxs/RepoYeti/issues/16).

## [1.6.3] - 2026-08-11

### Changed

- **Silent self-updates are now opt-in; the app always tells you instead.** Since 1.5 the daemon
  quietly updated and restarted itself by default. It now follows the same policy as our other
  apps: a check still runs on the same cadence, but by default an available update is announced
  (a persistent toast with an "Update now" button, riding a new daemon-wide event stream at
  `GET /api/events`) rather than installed behind your back. Setting `autoUpdate: true` restores
  exactly the old silent behavior, active-run deferral and dirty-tree guard included, and the new
  `updateNotify` setting can silence the announcements. The reasoning is borrowed from
  QuickDictate's v0.5.4 change: an unattended installer means anyone able to publish a release
  reaches every install within a day, so installing stays a human's click.

## [1.6.2] - 2026-08-10

### Added

- **Anonymous install ping**, via the same Studio endpoint the update check already calls
  (`studio.connections.icu/v1/app/redesign/latest`, which returns GitHub's `releases/latest`
  JSON verbatim). Packaged builds get it for free on every update check, decorated with a random
  install id and the app version; a new boot-time ping covers from-source-never-touches-that-URL
  and headless runs that never open the web UI, throttled to once per 24h and never fired from a
  source checkout or dev/test/CI. Every failure is swallowed; nothing about the run (files,
  screenshots, API keys) is sent. Documented in README's Privacy section, opt out with
  `REDESIGN_NO_PING=1`.

### Removed

- **The dormant `REDESIGN_PULSE_URL` pulse mechanism** (`POST /api/pulse`, its
  `bootstrap.ts` `recordPulse` helper, and every call site in `auto-update.ts`/`updates.ts`/
  `app-lifecycle.ts`), deleted outright. No collector ever existed for it; the install ping above
  replaces it.

## [1.6.1] - 2026-08-10

### Added

- **A Windows download that can show a system-tray icon.** The new
  `redesign-windows-x64-with-tray.zip` bundles the same executable with the `misc\` tray toolkit.
  RēDesign draws no tray icon itself, a small separate launcher does, so a release download could not
  have one however its settings were set, and the script that sets it up was reachable only from a
  clone. Grab that zip, run `misc\Create-Shortcut.ps1` once, and launch from the shortcut. The
  plain zip is unchanged: it is the automatic updater's transport and stays a single file.

### Fixed

- **The tray icon survives an Explorer restart.** When the Windows shell restarts it destroys every
  tray icon and expects each app to add its own back. The launcher never listened for that, so the
  icon vanished for the rest of the session while the app kept running normally, and relaunching
  the shortcut only reopened the UI.
- **A tray icon that fails to appear at startup now retries instead of giving up.** The launcher
  assumed its first attempt had worked; if it had not (most often because the taskbar did not exist
  yet, on a launcher started at logon), nothing ever tried again.

## [1.6.0] - 2026-08-09

### Security

- **The auto-updater now verifies what it downloaded before it runs it.** Every release already
  publishes a `SHA256SUMS.txt`; nothing checked it. The only integrity test was `verifyVersion()`,
  which *executes* the freshly downloaded binary and compares what it prints to the expected
  version, so a tampered release was authenticated by running it. The archive's SHA-256 is now
  matched against the published sums before it is unpacked or executed, and a missing, unreadable
  or mismatched checksum aborts the update. Auto-update is on by default and unattended, which is
  what made this worth closing first.
- **The API body-size cap now covers the API.** `body-limit.ts` said "every mutating JSON route is
  fronted by `bodyLimit()`"; it was actually wired onto two upload routes out of thirty-four. Every
  other route, `/api/run` and `/api/settings` included, parsed an unbounded body, and neither Hono
  nor Bun imposes a default. It is now applied once across `/api/*`, with the two upload routes
  keeping their larger 40 MB cap.
- **`GET /api/output/screenshot` is same-origin guarded.** It spawns headless Chromium per call and
  was the one route with a real side effect and no guard.
- Redaction covers the key formats the app itself routes to. The scrubber matched only prefixed
  keys, so Mistral's raw hex and Meta's `LLM_<appid>_<secret>` could survive into a job error, and
  job errors are persisted to the manifest and served over the API. It now also redacts by matching
  the actual configured key values, which covers any provider format, including future ones.

### Fixed

- **A failed manifest write no longer kills the daemon.** The 750 ms flush ran
  `store.writeManifest` inside a `setInterval` with no `try`/`catch`, and there is no
  `uncaughtException` handler, so one transient `ENOSPC`, `EPERM` or antivirus lock ended the
  process and took every other active and queued run with it. It now logs and retries on the next
  tick.
- **The `.env` holding every provider's keys is written atomically.** It was the one state file in
  the codebase rewritten in place rather than through the temp-file-plus-rename that `writeJSON`
  uses "to avoid corrupt state files". A crash mid-write could truncate every pool at once.
- **Generating a thumbnail can no longer overwrite a running run's manifest.** The thumbnailer read
  the manifest, then awaited up to 30 s of headless rendering, then wrote back the snapshot it took
  *before* the render, discarding every job result, count and cost written in between. It now
  re-reads immediately before writing.
- **Switching runs quickly no longer strands the viewer.** `load()` had no request sequencing, so a
  slow response for an older run could land last and, because accepting a finished-looking manifest
  stops the poll, silently close the live stream of the run actually selected. Same guard added to
  `bootstrap()`, which re-fires on every Control remount.
- **Jobs skipped for dead or cooling keys are visible again.** They carry a real explanation ("no
  API keys configured for X", "all keys cooling down") that the viewer dropped entirely and the
  progress card only showed while the run was live. This is exactly the out-of-credit and
  rate-limited case the run flow exists to explain.
- A local write failure after a successful, already-billed API call no longer discards the cost and
  benches a healthy key. Usage and cost are recorded the moment the call returns; a disk failure
  after that is reported as its own error and does not retry onto another key, which would have
  paid twice for the same output.
- Gemini thinking tokens are counted. `thoughtsTokenCount` is billed as output and reported
  separately from `candidatesTokenCount`, and nothing read it, so reasoning-capable Gemini runs
  under-reported spend.
- Key health from the last 400 ms survives shutdown; the debounced save is now flushed before exit.
- Failure messages in the viewer are readable in full via tooltip instead of being cut at 140
  characters, output preview iframes have accessible names, and the progress card no longer prints
  the raw internal status enum next to translated labels.
- Prices no longer freeze at whatever they were on the day of install. `pricing.json` was seeded
  once and never refreshed, including across auto-updates, despite having no user-editable path.

### Added

- **Retry just the failed jobs.** `POST /api/runs/:id/retry` re-runs only the failed, skipped or
  cancelled jobs of a run instead of paying for the whole fan-out again because one key died. It
  groups by input and prompt and submits per-model quantities, so the retry reproduces exactly the
  failed set and never silently re-runs combinations that already succeeded.
- **Download a whole run.** `GET /api/runs/:id/download` streams a zip of a run's successful
  outputs, built by a small dependency-free writer.
- **Run again.** A finished run can prefill the control panel from its own manifest, which now also
  records the brand style guide so a rerun is genuinely reproducible.
- A desktop notification when an unattended run finishes and the tab is hidden.
- Search in the all-runs gallery.
- Opt-in output retention (`outputRetentionDays`, off by default) swept once at boot, plus a
  disk-usage readout in Settings. Nothing had ever removed a run except the user.
- `--model-quantities` and `--brand-style-guide` / `--brand-style-guide-file` on `redesign run`, and
  `model_quantities`, `brand_style_guide`, reference fields and a `retry_run` tool on the MCP
  server. The README promised every UI feature had a command-line twin; these two did not.

### Internal

- **`npm run build` works again.** It had been failing outright while CI stayed green, because the
  checkout was left half-migrated: `src/web/bunfig.toml` was deleted without a matching reinstall,
  so `node_modules` no longer matched the linker that produced it and Rolldown could not resolve
  `clsx`. The repo-level `bunfig.toml` files are gone for good (install strategy is machine-specific
  and a committed `[install]` block breaks cold CI runners), the install is clean again, and both
  install paths are now verified: Bun locally, `npm ci` in CI and in the release build.
- `src/web`'s `patchedDependencies` entry is documented rather than mysterious. `vue-sonner` does
  not declare `vue` as a peer, which only matters under an isolated linker where its files live
  outside the project and nothing up the tree resolves `vue`. It is load-bearing for a Bun install
  and inert for an npm one.
- CI runs Biome. It had been configured since the repo started and gated on nothing.
- The per-job worker moved out of `runReimagine` into `runner/job-worker.ts`. It was ~225 lines
  inside an already 500-line function, closing over two dozen bindings; the body is unchanged and
  its dependencies are now an explicit context object.
- The output height-measure script is embedded when an output is written instead of injected on
  every request, so previews stream off disk. Pre-existing outputs migrate on first view.
- The custom-option sub-dialog moved out of `PromptBuilderDialog.vue` (821 lines to 608).
- `/api/bootstrap` walks the run directory once instead of twice, run manifests are written
  compactly by every writer, and each job's HTML is written asynchronously. A directory-mtime cache
  for the input and reference listings was tried and removed again: it could not see a file added
  more than one level deep inside a group, and it let an upload re-list from a stale entry in the
  same request that wrote. Guarding that costs more than the walk it saved.
- Tests for the untested `.env` rewriting in `server/settings.ts`, and request-level smoke coverage
  for the route modules that had none.
- Take the shared kit's injection-proof `detached-spawn`. Its WMI-unavailable fallback built a
  `cmd /c start ""` string and let cmd re-parse its own metacharacters, so an argv element holding
  `&`, `|` or `^` (all legal in a Windows filename, and this primitive is handed file paths) broke
  out as a separate command. It now hands off through PowerShell `Start-Process -ArgumentList`
  with each argument pre-quoted, so nothing re-splits.
- The README no longer claims keys never hit disk in the clear; it says where they actually live.

## [1.5.3] - 2026-08-06

### Changed

- **Inter ships with the app instead of being fetched from Google's CDN.** The shared kit's base
  stylesheet opened with a remote `@import`, and a remote import at the head of a render-blocking
  stylesheet is itself render-blocking: nothing painted until the browser had been to Google and
  back. That is free on a warm HTTP cache, which is why it went unnoticed, but it is dead time on
  a first run or after a cache eviction, and an outright stall with no network, in a local app
  that otherwise never needs to be online. Both Latin subsets of Inter's variable woff2 now ship
  with the web bundle, so the UI renders offline, with no flash of fallback text.

### Internal

- CI and Release can be started manually, so a commit or a tag can be built without waiting on a
  webhook. GitHub's standard mitigation for an Actions incident is to throttle webhook triggers,
  which lands the push and creates no run at all.
- Follow the sibling app's rename to AgentHydra in vendored comments.

## [1.5.2] - 2026-08-01

### Fixed

- Put a toast's close button in its top-right corner. vue-sonner defaults it to the top-LEFT,
  where it reads as a stray control floating beside the card rather than that card's own dismiss,
  and it disagreed with every other dismiss in the app (dialogs, sheets), which all sit top-right.
  It remains a default rather than a hard-code, so a caller can still move it back.
- Handle the tray host's async rebuild more reliably, and show the dev tree correctly alongside a
  packaged install.

### Internal

- Take the shared UI kit's toggle contrast fix and its grip-drag reset glide. Neither component
  has a consumer in this app yet; the copies are carried so they stay in step with the kit.

## [1.5.1] - 2026-07-28

### Fixed

- Keep live settings in one place, `~/.redesign/config/`, whether the app is packaged or run
  from source. Running from source pointed at `src/config/` itself, so saving a prompt, adding a
  model, or building a Prompt Builder combination wrote user data into files that are tracked in
  git and compiled into the shipped binary as seeds: a working copy went dirty on ordinary use,
  and a stray commit would have published private presets. Those files are now seeds only, and
  the test suite runs against them in an isolated home so a developer's own settings cannot
  change the result of a test run.

## [1.5.0] - 2026-07-28

### Changed

- Ground every run against a written inventory of the screenshot, and retire the "Ground with
  description" toggle (along with the CLI `--ground` flag and the MCP `ground` argument). A
  head-to-head test over two screenshots, five vision models, two prompts and two variants gave
  grounding 9 of the 20 model-and-prompt matchups on content fidelity against 1, the rest tied and
  the single loss going to a model that was truncating at its token limit under both conditions. It
  kept all of a dense panel's content where ungrounded runs kept 87%, and blind judging over the
  same 39 output pairs preferred it overall, with a third as many dropped elements and half as many
  fabricated ones. The cost is one shared description call per input, so there was nothing left for
  a setting to decide.

### Fixed

- Rotate to another API key when a generation fails on a dead or exhausted one, instead of failing
  the request while healthy keys sit unused. The screenshot-description and run-naming calls used to
  try a single key and silently give up, which cost a run its grounding; they now rotate like the
  main generation loop, which itself now gets one attempt per key in the pool rather than a fixed
  six. A model whose keys are all revoked is also no longer chosen to describe screenshots.
- Clear the run progress card on load when the run it was watching finished more than five minutes
  ago, so opening the app later starts on an empty card instead of replaying an old run's results.
  A run still queued or generating is always restored, however long the app was closed.
- Raise Qwen 3.5 Plus's output limit, which was half the rest of the fleet and truncated most of its
  pages mid-document.

## [1.4.1] - 2026-07-26

### Added

- Add a composable Prompt Builder with independent redesign scope, structure, and visual-system
  options. Users can create, edit, and reuse their own options; combinations compile into one
  prompt and bookmarks retain stable snapshots of every selected custom instruction.
- Add hover deletion and keyboard-accessible multi-select deletion to the Viewer run gallery,
  including confirmation, active-run protection, and partial-failure recovery.

### Changed

- Ship the Windows app as an icon-bearing, single-file GUI executable with no console window.
  GitHub releases also retain a compact ZIP for the automatic updater, with no loose `web` or
  `node_modules` directories.
- Upgrade Connections settings sync to the multi-device-safe 1.2 engine. Empty accounts seed in
  one operation, nested concurrent edits no longer overwrite unrelated preferences, and shutdown
  gets five seconds to flush before a stuck token or network request is cancelled.

## [1.4.0] - 2026-07-24

### Added

- Add an **All runs** gallery to the viewer. Each run gets a durable thumbnail from its input;
  older runs can backfill one from a surviving input or a headless render of their first
  successful output.
- Make the run queue explicit and controllable: park several batches, run the whole queue in one
  action, add work behind a live queue, and drag waiting runs into a new order.
- Add optional **Ground with description** preprocessing. A vision model inventories the source
  screenshot once and supplies that shared description to every image model for more faithful
  results.
- Add image clipboard support to the screenshot and reference drop zones, including a
  right-click **Paste** action and routing tests that keep the two targets separate.

### Changed

- Open the viewer without a run at the new run gallery instead of silently choosing the newest
  run. Output stars and hidden-item choices now survive refreshes, while live jobs update over SSE
  instead of repeatedly polling and replacing the full manifest.
- Improve large-run rendering: output jobs are indexed in one pass, off-screen previews stay
  unmounted until they approach the viewport, and generated-page autofocus can no longer drag the
  host viewer down the page.
- Consolidate the three presentation toggles under **Appearance**, simplify model/prompt selected
  states, clarify Connections sign-in/disconnect actions, and surface the installed app version
  beside update controls.
- Make daemon restarts and tray health checks more resilient: runtime pointers follow port
  changes, foreign processes are rejected, and transient failed probes no longer kill a healthy
  daemon.
- Correct DeepSeek scheduling and cost accounting so the shared screenshot description is not
  charged twice or truncated while a model is still waiting for it.

### Fixed

- Fix the shared updater integration tests on Windows installations where `bun` resolves through
  an npm command shim.
- Remove the CI test's dependency on a local sample image so the daemon suite is hermetic on all
  three release operating systems.
- Keep tall dialogs inside the viewport and make the localization key scan understand indirect
  references.

## [1.3.0] - 2026-07-16

### Added

- Add measured first-run sizing for portable windows and carry the intended size through Chromium
  launches that are forwarded into an existing browser process.
- Seal Connections OAuth refresh tokens at rest with Windows DPAPI.
- Add behavioral coverage for portable-window placement, loopback request guards, token sealing,
  and tray launch behavior.

### Changed

- Finish the Reimagine-to-ReDesign launcher asset rename and share the hardened daemon
  restart/wait helpers with the other LunarWerx desktop tools.
- Replace heuristic tray daemon detection with an authenticated loopback health check.

### Security

- Apply the shared loopback-origin guard to the HTTP service and protect the last unguarded
  mutating cost-estimate route.

## v1.2.0 - 2026-07-13

- Add Muse Spark 1.1 (`muse-spark-1.1`) as a first-class model on a new Meta AI provider (`metaai`, `https://api.meta.ai/v1`, OpenAI-compatible chat-completions with `Bearer` auth). It ships enabled and starred. Muse Spark is a reasoning model that spends "reasoning" tokens (billed inside completion/output tokens) before the visible answer, so its `maxTokens` is set generously (32000) to leave room for a full self-contained HTML page on top of the thinking budget. Verified live against the endpoint: vision (image_url) input, temperature, and `max_tokens` are all accepted. Meta AI keys (`LLM_<app_id>_<secret>`) are recognized by prefix in the "Paste keys" flow and route straight to the `METAAI_API_KEYS` pool with no live probe (covered in `tests/keyDetect.test.ts`).
- Paste one or many API keys and have them auto-filed. A new "Paste keys" flow (`POST /api/keys/import`) takes a blob in any layout (new lines, commas, spaces, or whole `.env` lines), detects which service each key belongs to by prefix (`sk-ant-` to Anthropic, `AIza` to Gemini, `sk-proj-`/`sk-svcacct-` to OpenAI, `xai-`, `sk-or-v1-`, `gsk_`, and so on), and for a bare `sk-` that OpenAI-legacy, DeepSeek, Qwen and Moonshot all share, verifies the key live against each candidate service's free list-models endpoint (read-only, never a generation call) to disambiguate. Keys route into the right pool or pools (a single Google key fills both Gemini pools), dedupe against what is already stored, and report a per-key result. The Models and keys tab gets a "Paste keys" button, and a keyless first run leads with a prominent paste box instead of the old model-first form. Detection is covered by unit tests in `tests/keyDetect.test.ts`.
- Add "Browse & add models" to the picker's "all models" drawer: pick a provider and it pulls that provider's live catalog (your account's real model list, or the models.dev catalog when no key is stored), then one click adds any of them as a configured model with sensible defaults. Already-configured models show as "Added". Added models inherit their vision (image-input) setting from the catalog when it's known, so a text-only model is created text-only instead of always defaulting to vision-on. This is the fast path to broad coverage without hand-filling the model form.
- Ship off-by-default starter models for every added provider: xAI (Grok 4), Groq (Llama 3.3 70B), Mistral (Mistral Large), OpenRouter (Auto) and Moonshot (Kimi K2). They exist so their key pools are real, which means a pasted key for any of them routes somewhere instead of coming back "no matching service". Enable one (and confirm its exact model id) to use it, or add a specific model through Browse & add.
- Rework the model picker into a starred tier plus an "all models" drawer, VS Code Copilot style. A new `starred` flag on each model (persisted in `models.json`, so it travels to the CLI/MCP and syncs across devices) pins your go-to models to the top; everything else sits in a searchable, provider-grouped drawer one click below. A star toggle on every row promotes or demotes without opening the editor (`POST /api/models/star`). The per-model quantity stepper is unchanged. Ships with Claude Opus, GPT 5.6 Sol and Gemini 3.1 Pro starred, and the previously hidden GPT 5.6 Terra/Luna variants enabled so the drawer has depth.
- Broaden the provider registry so a service is a first-class thing. DeepSeek and Qwen now carry their own provider ids (they were both filed under `openai`), and xAI, OpenRouter, Groq, Mistral and Moonshot ship as known providers (all OpenAI-compatible, so they reuse that adapter). This drives service-level grouping in the picker, richer key auto-detection, and a longer provider list in the model editor. `redactSecrets` learned the new key shapes (`xai-`, `gsk_`, hyphenated `sk-or-v1-`) so they never reach logs.
- Add a per-model quantity to the model picker: each selected model now shows a copies stepper (1-10, default 1), so a single run can generate, say, three variants of one model and one of another. This replaces the old global "Variants / model" number in Advanced options. The per-model count is sent as an id-keyed `modelQuantities` map (robust against the config-order in which models resolve), threads through `buildJobs` (`inputs × models × prompts × per-model copies`), and feeds an accurate pre-run estimate via a new optional `jobCountByModel` on `POST /api/costs/estimate`. The CLI/MCP flat `variants` number still works as the default for any model without an explicit quantity.
- Stop Mock-mode runs from counting as real spend anywhere. Mock jobs emit a tiny canned (~1.5k-token) output with zero input and spend no real quota, but they were being priced and averaged like real API calls. Now they are excluded from the pre-run estimate's historical average (`averageUsageByModel`), from each run's cost meter and spend-to-date (`runReimagine`/`runCost`/`spendToDate`, which also drops any older mock manifests carrying a baked-in cost), everywhere via a shared `isMockUsage` guard. This was the cause of a badly under-shooting estimate: a single GPT-5.5 faithful-refresh estimated ~8c but really cost ~26c because recent history was ~100 mock jobs to ~20 real ones; with mock excluded the same estimate is ~27c.
- Show the pre-run estimate as a point value plus a low-high band (e.g. `≈ $0.27 ($0.10-$0.41)`) when a model's recent runs varied enough that a single number would mislead. A dense screenshot emits far more HTML (and so costs far more) than a simple one, and the estimate is a per-model historical average that can't see which screenshot is coming; the band (each model's cheapest and priciest observed output, `totalCostLow`/`totalCostHigh` on `POST /api/costs/estimate`) makes that uncertainty visible instead of hiding it behind one falsely-precise figure. Tight spreads still show a single number.
- Move the viewer's View options out of the Settings sheet into their own header flyout: a new sliders icon to the left of the gear (viewer route only) opens a popover with the Project/Display/Layout/Filters/Status controls, so filtering the output gallery no longer means opening Settings. The Settings sheet on the viewer now carries just Preferences and App, and opens to Preferences.
- Brand tray/taskbar icon regenerated from the current "Rē" vector (the shipped `misc/Reimagine.ico` had drifted to a generic placeholder). `misc/Build-Icon.ps1` now rebuilds it from the committed `misc/Reimagine-icon.png` master (re-rendered from `src/web/public/icon.svg`) instead of from the old `.ico`; the web `favicon.ico` was refreshed too.
- Settings sheet split into tabs (shared kit segmented tab bar): "Models & keys" ("View" on the viewer route) opens selected as the sheet's main job, "Preferences" holds the per-machine toggles (tooltips, portable window), and "App" holds cloud sync, updates, and server actions.
- Hop to a free port when the preferred one (default 5178) is held by a foreign process, instead of retrying the same port and dying, matching the sibling apps' loopback-aware probe (`findFreePort`, binds `127.0.0.1` specifically so a squatter on the loopback interface is detected).
- Record the port the daemon actually bound in a runtime pointer at `~/.redesign/runtime.json` (override with `REDESIGN_HOME`), so the CLI, tray, and `start.cmd` can all find the live instance even after a hop.
- Add `GET /api/health` (plain liveness: `{ ok, service: "redesign", ts }`), used by the runtime pointer and the tray to confirm a running instance is actually RēDesign before trusting it.
- `redesign serve`, `redesign status`, and `redesign stop` now resolve the live daemon through the runtime pointer first, falling back to probing the preferred port.
- The auto-update relaunch handoff (`REDESIGN_RELAUNCH=1`) keeps rebinding the exact same port as before, so an open browser tab's bookmarks and SSE connection stay valid across an update.
- Add `REDESIGN_PORT_FIXED=1` as a sibling-parity escape hatch: binds the preferred port exactly, no probing, no hop.
- Tray (`misc/ReDesign-Tray.ps1`): reads the runtime pointer to open/menu-open the URL the daemon actually bound, validated via `/api/health`; add a `-SelfTest` switch (bun on PATH, daemon entry present, tray icon loads into a real NotifyIcon) for headless verification, run before any tray/mutex/daemon work.
- `start.cmd` resolves the URL to open from the runtime pointer, falling back to `http://localhost:5178`.
- Add `check:kit` to catch drift between this app's synced kit files and the shared LunarWerx kit, wired into `npm run check`.
- Add a "Portable window" setting (Settings sheet, `portableMode`, off by default): opens the app in a chromeless Edge/Chrome `--app=` window instead of a browser tab, both from the toggle itself (`POST /api/portable-window`) and from the tray/`start.cmd` launcher, which reads the setting back out of `~/.redesign/runtime.json`. The window gets its own dedicated Chromium profile (`~/.redesign/portable-profile`), so it remembers its own size/position across launches instead of sharing the main browser profile.

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

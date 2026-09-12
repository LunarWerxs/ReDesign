/**
 * GET /api/bootstrap, the single payload the web UI loads on boot.
 * Ported from server.js.
 *
 * This used to also carry POST /api/pulse, a dormant event-pulse route that posted to an
 * operator-supplied REDESIGN_PULSE_URL no collector has ever existed for. Retired in favor of
 * the real anonymous install ping in src/install-ping.ts (see cli/lifecycle.ts's serveCmd and
 * github-updater.ts), which needs no client-driven route at all.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { listInputs, listReferences } from "../../inputResolver";
import {
  keySnapshot,
  modelSettings,
  publicPromptBuilderOptions,
  publicPrompts,
} from "../../server/settings";
import * as store from "../../store";
import { runStoreOptions } from "../runQueue";
import { cachedSpendToDate } from "../../runner";
import { PROVIDER_DEFAULTS } from "../../config/shared";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/bootstrap", (c) => {
    const settings = modelSettings();
    // Keep the visible history page bounded; lifetime spend has a separate short-lived cache.
    const runOptions = runStoreOptions();
    const runs = store.listRunsPage({ limit: 50, options: runOptions }).runs;
    return c.json({
      models: settings.models,
      archivedModels: settings.archivedModels,
      prompts: publicPrompts(),
      builderOptions: publicPromptBuilderOptions(),
      inputs: listInputs(),
      references: listReferences(),
      keys: keySnapshot(),
      runs,
      // Spend remains an all-history aggregate; never derive it from the visible page or the
      // control panel would under-report older paid runs.
      spend: cachedSpendToDate(runOptions),
      providerDefaults: PROVIDER_DEFAULTS,
    });
  });
}

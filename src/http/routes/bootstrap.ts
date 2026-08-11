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
import { spendToDate } from "../../runner";
import { PROVIDER_DEFAULTS } from "../../config/shared";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/bootstrap", (c) => {
    const settings = modelSettings();
    // One run-directory walk, shared by the run list and the spend total (spendToDate would
    // otherwise repeat it): this is the endpoint every page load hits.
    const runOptions = runStoreOptions();
    const runs = store.listRuns(runOptions);
    return c.json({
      models: settings.models,
      archivedModels: settings.archivedModels,
      prompts: publicPrompts(),
      builderOptions: publicPromptBuilderOptions(),
      inputs: listInputs(),
      references: listReferences(),
      keys: keySnapshot(),
      runs: runs.slice(0, 50),
      spend: spendToDate(runOptions, runs),
      providerDefaults: PROVIDER_DEFAULTS,
    });
  });
}

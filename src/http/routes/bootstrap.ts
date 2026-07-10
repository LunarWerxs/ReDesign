/**
 * GET /api/bootstrap, the single payload the web UI loads on boot.
 * POST /api/pulse, fire-and-forget product-analytics pulse (no-op until a pulse URL is set).
 * Ported from server.js (both routes + the inline recordPulse() helper).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { ROOT, readJSON, writeJSON } from "../../util";
import { listInputs, listReferences } from "../../inputResolver";
import { modelSettings, publicPrompts, keySnapshot } from "../../server/settings";
import * as store from "../../store";
import { runStoreOptions } from "../runQueue";
import { spendToDate } from "../../runner";
import { PROVIDER_DEFAULTS } from "../../config/shared";

// Fire-and-forget product pulse, a no-op until REDESIGN_PULSE_URL (or the shared
// CONNECTIONS_PULSE_URL) is set. Kept inline; no dedicated module (mirrors server.js).
const PULSE_STATE = path.join(ROOT, "output", ".reimagine-state.json");

interface PulseState {
  pulseInstallId?: string;
  analyticsInstallId?: string;
  [key: string]: unknown;
}

async function recordPulse(event: string, properties?: unknown): Promise<{ ok: boolean; enabled: boolean }> {
  const url = (process.env.REDESIGN_PULSE_URL || process.env.CONNECTIONS_PULSE_URL || "").trim();
  if (!url) return { ok: true, enabled: false };
  const state = readJSON<PulseState>(PULSE_STATE, {});
  if (!state.pulseInstallId) {
    state.pulseInstallId = state.analyticsInstallId || crypto.randomUUID();
    delete state.analyticsInstallId;
    fs.mkdirSync(path.dirname(PULSE_STATE), { recursive: true });
    writeJSON(PULSE_STATE, state);
  }
  const token = (process.env.REDESIGN_PULSE_TOKEN || process.env.CONNECTIONS_PULSE_TOKEN || "").trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ source: "connections", app: "redesign", installId: state.pulseInstallId, event, properties, ts: new Date().toISOString() }),
    });
    return { ok: res.ok, enabled: true };
  } catch {
    return { ok: false, enabled: true };
  }
}

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/bootstrap", (c) => {
    const settings = modelSettings();
    return c.json({
      models: settings.models,
      archivedModels: settings.archivedModels,
      prompts: publicPrompts(),
      inputs: listInputs(),
      references: listReferences(),
      keys: keySnapshot(),
      runs: store.listRuns(runStoreOptions()).slice(0, 50),
      spend: spendToDate(runStoreOptions()),
      providerDefaults: PROVIDER_DEFAULTS,
    });
  });

  app.post("/api/pulse", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { event?: string; properties?: unknown };
    const result = await recordPulse(String(body.event || ""), body.properties);
    return c.json(result, result.ok ? 200 : 400);
  });
}

export { recordPulse };

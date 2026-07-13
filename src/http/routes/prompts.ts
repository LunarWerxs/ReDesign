/**
 * POST /api/prompts/save · /delete · /restore-defaults. Ported from server.js.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { savePromptPreset, setPromptStarred, deletePromptPreset, restoreDefaultPrompts, type PromptInput } from "../../config";
import { publicPrompts } from "../../server/settings";

export function register(app: Hono, _deps: Deps): void {
  app.post("/api/prompts/save", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as PromptInput;
    const prompt = savePromptPreset(body);
    return c.json({ prompt, prompts: publicPrompts() });
  });

  app.post("/api/prompts/star", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string; starred?: boolean };
    try {
      const prompt = setPromptStarred(body.id as string, body.starred !== false);
      return c.json({ prompt, prompts: publicPrompts() });
    } catch (e) {
      const status = (e as { status?: number }).status || 400;
      return c.json({ error: e instanceof Error ? e.message : "star failed" }, status as 400);
    }
  });

  app.post("/api/prompts/delete", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
    const id = deletePromptPreset(body.id as string);
    return c.json({ id, prompts: publicPrompts() });
  });

  app.post("/api/prompts/restore-defaults", requireSameOrigin(), (c) => {
    restoreDefaultPrompts();
    return c.json({ prompts: publicPrompts() });
  });
}

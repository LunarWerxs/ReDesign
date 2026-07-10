/**
 * GET /api/inputs, POST /api/inputs/upload (40 MB body cap), POST /api/inputs/delete.
 * GET /input/*, GET /reference/* static file serving (subject images + style references).
 * Ported from server.js + the /input, /reference routes.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { requireSameOrigin } from "../origin-guard";
import { jsonBodyLimit } from "../body-limit";
import { serveFile } from "../fileServing";
import { listInputs, saveUploadedImages, deleteInput, INPUT_DIR, REFERENCE_DIR, type UploadInput } from "../../inputResolver";

const UPLOAD_BODY_LIMIT_BYTES = Math.max(1, Number.parseInt(process.env.UPLOAD_LIMIT_MB || "", 10) || 40) * 1024 * 1024;
const UPLOAD_IMAGE_LIMIT_BYTES = Math.max(1, Number.parseInt(process.env.UPLOAD_IMAGE_LIMIT_MB || "", 10) || 20) * 1024 * 1024;

export function register(app: Hono, _deps: Deps): void {
  app.get("/input/*", (c) => serveFile(c, INPUT_DIR, new URL(c.req.url).pathname.slice("/input/".length)));
  app.get("/reference/*", (c) => serveFile(c, REFERENCE_DIR, new URL(c.req.url).pathname.slice("/reference/".length)));

  app.get("/api/inputs", (c) => c.json(listInputs()));

  app.post("/api/inputs/upload", requireSameOrigin(), jsonBodyLimit(UPLOAD_BODY_LIMIT_BYTES), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { images?: UploadInput[]; image?: UploadInput };
    const images = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
    return c.json(saveUploadedImages(images, { maxBytes: UPLOAD_IMAGE_LIMIT_BYTES }));
  });

  app.post("/api/inputs/delete", requireSameOrigin(), async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as { id?: string };
    if (!body.id) return c.json({ error: "id is required" }, 400);
    return c.json({ inputs: deleteInput(String(body.id)) });
  });
}

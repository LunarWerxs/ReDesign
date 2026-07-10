/**
 * Small body-size guard, ported from server.js's readBody({limitBytes}) 413 behavior. Hono's
 * c.req.json() doesn't enforce a byte cap by default, so every mutating JSON route is fronted by
 * bodyLimit() (Hono's built-in body-limit middleware) with an onError that matches the original
 * JSON error shape (`{ error: 'body too large' }`, 413) instead of the middleware's default
 * plain-text 413.
 */
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";

const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

function jsonBodyLimit(maxSize: number = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "body too large" }, 413),
  });
}

export { jsonBodyLimit, DEFAULT_BODY_LIMIT_BYTES };

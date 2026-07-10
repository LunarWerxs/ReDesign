/**
 * Reject state-changing / key-spending requests that come from another origin (a drive-by page,
 * or a sandboxed model-output iframe whose Origin is "null"). Same-origin UI requests and tool
 * requests with no Origin header are allowed. Ported verbatim from server.js's originAllowed().
 *
 * RēDesign is NOT CORS-permissive like DevWebUI, do not swap this for `hono/cors` (that would
 * loosen the security posture).
 */
import type { Context, MiddlewareHandler } from "hono";

const PORT = Number.parseInt(process.env.PORT || "", 10) || 5178;
const HOST = process.env.HOST || "127.0.0.1";

function originAllowed(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true; // curl / CLI / same-origin navigations
  const allowed = [
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    // Vite dev server origin (npm run dev:web → :5173, proxied here). Harmless in prod (nothing
    // serves there); a real cross-origin attacker carries its own origin and is still rejected.
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  return allowed.includes(origin);
}

/** Hono middleware form: 403s a cross-origin mutating request before the route handler runs. */
function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    if (!originAllowed(c)) return c.json({ error: "cross-origin request blocked" }, 403);
    await next();
  };
}

export { originAllowed, requireSameOrigin, PORT, HOST };

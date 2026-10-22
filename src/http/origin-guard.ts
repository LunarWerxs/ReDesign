/** App-local policy on top of the vendored loopback guard. API requests require exact browser
 * provenance; every route checks Host, including cross-site OAuth returns and public files. */
import type { MiddlewareHandler } from "hono";
import { evaluateRequest } from "../loopback-guard.mjs";

const PORT = Number.parseInt(process.env.PORT || "", 10) || 5178;
const HOST = process.env.HOST || "127.0.0.1";

// Intentional Vite origins (src/web/vite.config.ts uses strictPort). Other local apps/ports
// receive no browser access. Request origin is resolved per request to support port hopping.
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"];

function requireLocalHost(): MiddlewareHandler {
  return async (c, next) => {
    const verdict = evaluateRequest({ host: c.req.header("host") || new URL(c.req.url).host });
    if (!verdict.ok) return c.json({ error: `forbidden: ${verdict.reason}` }, 403);
    await next();
  };
}

function requireSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const secFetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
    // Origin-less same-site image/script/fetch requests are still browser requests from a
    // DIFFERENT local origin. The kit's exact-origin option only checks a present Origin.
    if (secFetchSite === "same-site" && !origin) {
      return c.json({ error: "forbidden: same-site request requires a trusted Origin" }, 403);
    }
    const url = new URL(c.req.url);
    const verdict = evaluateRequest(
      { origin, secFetchSite, host: c.req.header("host") || url.host },
      { allowedOrigins: () => [url.origin, ...DEV_ORIGINS] },
    );
    if (!verdict.ok) return c.json({ error: `forbidden: ${verdict.reason}` }, 403);
    await next();
  };
}

export { requireSameOrigin, requireLocalHost, PORT, HOST };

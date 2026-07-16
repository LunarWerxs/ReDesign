/**
 * ReDesign's thin app-local wiring of the shared cross-site (CSRF) guard. Every mutating /api route
 * wraps `requireSameOrigin()`, which now returns the kit's shared `loopbackGuard` — the single
 * audited Sec-Fetch-Site + Origin + Host guard (src/loopback-guard.mjs), vendored from lunarwerx-ui
 * — in place of ReDesign's former hand-rolled Origin-allowlist. Same posture (mutating routes only;
 * GETs stay open), stronger guard (also catches the simple-request CORS bypass + DNS-rebinding).
 *
 * ReDesign is loopback-only (no tunnel), so the guard applies verbatim; never wire it on /oauth/*
 * (those are legit cross-site OAuth returns). PORT/HOST stay here — they are this app's bind config,
 * read by the settings route.
 */
import type { MiddlewareHandler } from "hono";
import { loopbackGuard } from "../loopback-guard.mjs";

const PORT = Number.parseInt(process.env.PORT || "", 10) || 5178;
const HOST = process.env.HOST || "127.0.0.1";

/** The shared cross-site guard as per-route middleware. Kept as a factory so the existing
 *  `requireSameOrigin()` call sites across the route modules are unchanged. */
function requireSameOrigin(): MiddlewareHandler {
  return loopbackGuard;
}

export { requireSameOrigin, PORT, HOST };

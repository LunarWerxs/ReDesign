/**
 * The renderer's browser is deliberately given a very small view of the host:
 * one ephemeral loopback origin which serves the document and its sibling assets.
 * This is defence in depth with CDP Fetch interception in thumbnail.ts; this helper
 * is kept separate so the security boundary is directly testable.
 */
export function isRendererRequestAllowed(url: string, origin: string): boolean {
  if (url.startsWith("data:")) return true;
  try {
    const target = new URL(url);
    if (target.origin !== origin) return false;
    return target.pathname === "/document" || target.pathname.startsWith("/asset/");
  } catch {
    return false;
  }
}

/** Make relative URLs resolve through the renderer's explicitly rooted asset route. */
export function rendererDocument(html: string): string {
  // The first base element wins. Put ours before the untrusted document so a generated
  // page cannot redirect relative resource lookups to another origin or local file path.
  return `<!doctype html><head><base href="/asset/"></head>${html}`;
}

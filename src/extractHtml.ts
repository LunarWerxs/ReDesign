// Pull a clean, self-contained HTML document out of a model response. Models
// sometimes wrap output in ```html fences or add a sentence of preamble; this
// normalizes all of that to something an iframe can render directly.
//
// Strategy order matters: we slice a full <!doctype>...</html> document FIRST,
// directly from the raw text. That transparently handles a ```html wrapper
// (the doctype lives inside the fence) AND is immune to a nested triple-backtick
// fence inside the document body, which would otherwise truncate output if we
// matched fences first.

interface ExtractedHtml {
  html: string;
  wrapped: boolean;
  hadFence: boolean;
}

function extractHtml(raw: unknown): ExtractedHtml {
  const text = String(raw == null ? "" : raw).trim();

  // 1) Full document anywhere in the text -> slice doctype/html .. </html>.
  const sliced = sliceDocument(text);
  if (sliced) return { html: sliced, wrapped: false, hadFence: /```/.test(text) };

  // 2) No full document. Try a fenced code block that contains markup.
  const fenceRe = /```(?:html|HTML)?\s*\n([\s\S]*?)```/g;
  let m = fenceRe.exec(text);
  while (m !== null) {
    const inner = m[1] as string;
    const innerDoc = sliceDocument(inner);
    if (innerDoc) return { html: innerDoc, wrapped: false, hadFence: true };
    if (/<body[\s>]|<main[\s>]|<section[\s>]|<div[\s>]/i.test(inner)) return { html: wrap(inner.trim()), wrapped: true, hadFence: true };
    m = fenceRe.exec(text);
  }

  // 3) Bare markup fragment with no <html> -> wrap minimally.
  if (/<body[\s>]|<main[\s>]|<section[\s>]|<div[\s>]/i.test(text)) {
    return { html: wrap(text), wrapped: true, hadFence: false };
  }

  // 4) Nothing renderable -> present the raw text so the failure is visible.
  return { html: wrap(`<pre style="white-space:pre-wrap;color:#e66">${escapeHtml(text) || "(empty response)"}</pre>`), wrapped: true, hadFence: false };
}

// Return the substring from the first <!doctype html>/<html ...> to its closing
// </html>, or null if no document start is present.
function sliceDocument(text: string): string | null {
  const docStart = text.search(/<!doctype html/i);
  const htmlStart = text.search(/<html[\s>]/i);
  const start = docStart !== -1 ? docStart : htmlStart;
  if (start === -1) return null;
  let out = text.slice(start);
  const closeRe = /<\/html\s*>/gi;
  let last: RegExpExecArray | null = null;
  let mm = closeRe.exec(out);
  while (mm !== null) {
    last = mm; // take the LAST </html>
    mm = closeRe.exec(out);
  }
  if (last) out = out.slice(0, last.index + last[0].length);
  return out.trim();
}

function wrap(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:24px}</style>
</head><body>
${inner}
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

export { extractHtml };
export type { ExtractedHtml };

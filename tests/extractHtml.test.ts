import { describe, expect, it } from "bun:test";
import { extractHtml } from "../src/extractHtml";

describe("extractHtml", () => {
  it("extracts a fenced ```html block", () => {
    const extracted = extractHtml(
      "blah\n```html\n<!DOCTYPE html><html><body>hi</body></html>\n```\nthanks"
    );
    expect(extracted.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(extracted.outcome).toBe("document");
  });

  it("slices from doctype, drops preamble", () => {
    const html = extractHtml(
      "Here is your design:\n<!doctype html><html><body>x</body></html>"
    ).html;
    expect(/here is/i.test(html)).toBe(false);
  });

  it("cuts trailing prose after </html>", () => {
    const html = extractHtml(
      "<!doctype html><html><body>x</body></html>\n\nHope you like it!"
    ).html;
    expect(html.endsWith("</html>")).toBe(true);
  });

  it("wraps a bare body fragment", () => {
    const w = extractHtml("<body><div>fragment only</div></body>");
    expect(w.wrapped).toBe(true);
    expect(w.outcome).toBe("fragment");
    expect(w.html.includes("<!DOCTYPE html>")).toBe(true);
  });

  it("empty input yields a visible wrapped doc", () => {
    const extracted = extractHtml("");
    expect(extracted.wrapped).toBe(true);
    expect(extracted.outcome).toBe("non-html");
  });

  it("classifies a prose refusal as non-HTML while retaining its diagnostic", () => {
    const extracted = extractHtml("I cannot produce the requested redesign.");
    expect(extracted.outcome).toBe("non-html");
    expect(extracted.html).toContain("I cannot produce the requested redesign.");
  });

  it("preserves a nested triple-backtick fence inside the document", () => {
    const nested = extractHtml(
      "```html\n<!doctype html><html><body><pre>```js\nconst x=1\n```</pre></body></html>\n```"
    );
    expect(nested.html.includes("const x=1")).toBe(true);
    expect(nested.html.trim().endsWith("</html>")).toBe(true);
  });
});

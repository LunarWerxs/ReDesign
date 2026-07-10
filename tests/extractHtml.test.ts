import { describe, it, expect } from "bun:test";
import { extractHtml } from "../src/extractHtml";

describe("extractHtml", () => {
  it("extracts a fenced ```html block", () => {
    const html = extractHtml(
      "blah\n```html\n<!DOCTYPE html><html><body>hi</body></html>\n```\nthanks"
    ).html;
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
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
    expect(w.html.includes("<!DOCTYPE html>")).toBe(true);
  });

  it("empty input yields a visible wrapped doc", () => {
    expect(extractHtml("").wrapped).toBe(true);
  });

  it("preserves a nested triple-backtick fence inside the document", () => {
    const nested = extractHtml(
      "```html\n<!doctype html><html><body><pre>```js\nconst x=1\n```</pre></body></html>\n```"
    );
    expect(nested.html.includes("const x=1")).toBe(true);
    expect(nested.html.trim().endsWith("</html>")).toBe(true);
  });
});

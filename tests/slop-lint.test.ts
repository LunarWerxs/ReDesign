import { describe, expect, it } from "bun:test";
import { lintHtml, slopFixBlock, summarizeSlop } from "../src/runner/slop-lint";

// Contract: the anti-slop rule table scores generated HTML deterministically, with P0 reserved for
// the patterns that trigger a paid retry. Regression: a rule regex silently matching nothing (no
// badge, no retry) or over-matching clean markup (a paid retry on every job). Seam: the lint API
// the job worker calls on every saved output.
const page = (style: string, body: string) => `<!DOCTYPE html><html><head><style>${style}</style></head><body>${body}</body></html>`;
const rules = (html: string, sourceText?: string) => lintHtml(html, { sourceText }).map((f) => `${f.severity} ${f.rule}`);

describe("anti-slop lint", () => {
  it("leaves a plain, token-based page without findings", () => {
    const html = page(":root{--ink:#1c1b19;--paper:#f4f1ea}body{color:var(--ink);background:var(--paper);font-family:'Fraunces',serif}", "<h1>Orders</h1><p>Three open.</p>");
    expect(lintHtml(html)).toEqual([]);
  });

  it("scores purple and blue-to-cyan gradients, CSS or Tailwind, as P0", () => {
    expect(rules(page(".hero{background:linear-gradient(135deg,#7c3aed,#db2777)}", "<h1>Hi</h1>"))).toContain("P0 purple-gradient");
    expect(rules(page("", '<div class="bg-gradient-to-r from-violet-600 to-pink-500">x</div>'))).toContain("P0 purple-gradient");
    expect(rules(page(".b{background:linear-gradient(90deg,#2563eb,#06b6d4)}", "<p>x</p>"))).toContain("P0 trust-gradient");
  });

  it("tells emoji icons (P0 when repeated) from emoji-free copy", () => {
    expect(rules(page("", "<div>\u{1F680}</div><div>✨</div><p>Fast</p>"))).toContain("P0 emoji-icon");
    expect(rules(page("", "<div>\u{1F680}</div><p>Fast</p>"))).toContain("P1 emoji-icon");
    expect(rules(page("", "<p>Next → Settings © 2026</p>"))).not.toContain("P1 emoji-icon");
  });

  it("flags only figures the grounding caption never mentioned", () => {
    const html = page("", "<p>Trusted by 10,000+ teams</p><p>Revenue $4,210</p>");
    const found = lintHtml(html, { sourceText: "Revenue: $4,210 this month" }).find((f) => f.rule === "invented-metric");
    expect(found?.snippet).toContain("10,000+");
    expect(found?.snippet).not.toContain("4,210");
    expect(rules(html)).not.toContain("P1 invented-metric");
  });

  it("scores lorem ipsum as P0 and template phrases as P1, unless the original used them", () => {
    expect(rules(page("", "<p>Lorem ipsum dolor sit amet</p>"))).toContain("P0 filler-copy");
    expect(rules(page("", "<h1>Unlock the power of seamless analytics</h1>"))).toContain("P1 filler-copy");
    expect(rules(page("", "<h1>Seamless sync</h1>"), "Header reads: Seamless sync")).not.toContain("P1 filler-copy");
  });

  it("summarizes by severity and feeds only P0 findings back into the retry prompt", () => {
    const findings = lintHtml(page(".h{background:linear-gradient(#7c3aed,#db2777)}.k{text-transform:uppercase}", '<img src="https://images.example.com/a.jpg"><p class="h">x</p>'));
    const summary = summarizeSlop(findings);
    expect(summary.p0).toBe(1);
    expect(summary.p1).toBeGreaterThanOrEqual(1); // external-image
    expect(summary.p2).toBeGreaterThanOrEqual(1); // all-caps-no-tracking
    const block = slopFixBlock(findings);
    expect(block).toContain("purple-gradient");
    expect(block).not.toContain("external-image");
  });
});

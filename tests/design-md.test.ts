// Pins the DESIGN.md handoff (src/design-md.ts): the tokens a chosen redesign's HTML declares
// must reach the front matter in the right role, and styled states must reach the components map,
// or the next agent is back to re-guessing the look the user picked.
import { expect, test } from "bun:test";
import { buildDesignMd, extractDesignTokens } from "../src/design-md";

const PAGE = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --brand: #5b21b6; --radius: 12px; }
  #facade { color: #111 }
  body { background: #FAFAFA; color: #1f2937; font: 500 16px/1.5 "Inter", sans-serif; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .btn { background-color: #5b21b6; color: #fff; border-radius: 8px; }
  .btn:hover { background-color: #4c1d95; }
  @media (prefers-color-scheme: dark) { body { background: #0b0b0f; } }
</style></head><body>
<nav class="navbar" style="background:#5b21b6"><a href="#">Home</a></nav>
<div class="card"><button class="btn">Go</button><button class="rounded-full bg-emerald-500 focus-visible:ring-2 px-4">Alt</button></div>
</body></html>`;

test("extracts role-bucketed colours, fonts, radii and custom properties", () => {
  const t = extractDesignTokens(PAGE);
  expect(t.colors.background[0]).toBe("#5b21b6");
  expect(t.colors.background).toContain("#fafafa");
  expect(t.colors.background).toContain("bg-emerald-500");
  expect(t.colors.text).toContain("#1f2937");
  expect(t.colors.border).toContain("#e5e7eb");
  // A hex-looking id selector must not be read as a colour.
  expect(Object.values(t.colors).flat()).not.toContain("#facade");
  expect(t.fonts).toEqual(expect.arrayContaining(["Inter", "Space Grotesk"]));
  expect(t.radii).toEqual(expect.arrayContaining(["12px", "8px", "rounded-full"]));
  expect(t.variables).toContainEqual(["--brand", "#5b21b6"]);
  expect(t.darkVariant).toBe(true);
});

test("maps components with the states the page styles", () => {
  const button = extractDesignTokens(PAGE).components.find((c) => c.name === "Button");
  expect(button?.count).toBe(2);
  expect(button?.states).toEqual(["focus-visible", "hover"]);
});

test("renders front matter plus Components, Do's, Don'ts and Known Gaps", () => {
  const md = buildDesignMd(PAGE, { label: "claude / bold", file: "out/a.html", runId: "r1" });
  expect(md.startsWith("---\nname: \"claude / bold\"\n")).toBe(true);
  expect(md).toContain("colors:\n  background:\n    - \"#5b21b6\"");
  for (const heading of ["## Components", "## Do's", "## Don'ts", "## Known Gaps"]) expect(md).toContain(heading);
  expect(md).toContain("- **Button** (2 in the mockup) - states: `focus-visible`, `hover`");
});

test("names a missing focus style as a known gap", () => {
  const md = buildDesignMd("<style>button:hover{color:#000}</style><button>x</button>", { label: "x", file: "x.html" });
  expect(md).toContain("No focus style was found");
  expect(md).toContain("No dark-mode variant was found");
});

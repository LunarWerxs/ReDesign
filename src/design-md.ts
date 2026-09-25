/**
 * DESIGN.md handoff for a chosen redesign.
 *
 * WHY: a run ends at standalone HTML mockups, so once the user picks a winner the next coding
 * agent has to re-guess its palette, type and spacing. This turns one output's HTML into a
 * DESIGN.md: a token front matter, a components map with the state variants the page styles,
 * Do/Don't rules derived from those tokens, and the gaps a static read cannot see.
 *
 * The file shape (token front matter, components with states, Do's and Don'ts) follows the idea
 * behind VoltAgent/awesome-design-md (MIT); nothing is copied from it. Extraction is a static,
 * offline read of the HTML's own CSS and utility classes: no browser, no model call, no network,
 * so exporting stays free and works on a mock run.
 */

/** Outputs past this size are read only up to it; a generated page is far smaller. */
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const TOP = 8;

export interface DesignMdSource {
  /** Human label for the output, e.g. the job id or "model / prompt". */
  label: string;
  /** Archive-relative or run-relative path of the HTML the tokens came from. */
  file: string;
  runId?: string;
}

export interface DesignTokens {
  variables: [string, string][];
  colors: { background: string[]; text: string[]; border: string[]; other: string[] };
  fonts: string[];
  fontSizes: string[];
  radii: string[];
  spacing: string[];
  shadows: string[];
  utilityClasses: boolean;
  darkVariant: boolean;
  components: { name: string; count: number; states: string[] }[];
}

class Counter {
  private readonly counts = new Map<string, number>();
  add(value: string | null | undefined, by = 1): void {
    const v = (value || "").trim();
    if (v) this.counts.set(v, (this.counts.get(v) || 0) + by);
  }
  top(n = TOP): string[] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([v]) => v);
  }
}

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)/gi;
// Tailwind-style colour utilities: bg-slate-900, text-[#1e293b], border-emerald-500/40.
const TW_COLOR_RE = /^(bg|text|border|ring|from|via|to|fill|stroke|divide|outline|accent|decoration)-((?:[a-z]+-\d{2,3}|white|black|transparent|current)(?:\/\d+)?|\[[^\]]+\])$/;
const TW_TEXT_SIZE_RE = /^text-(xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em)\])$/;
const TW_SPACING_RE = /^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.5)?|px|\[[^\]]+\])$/;
const TW_STATE_RE = /^(hover|focus|focus-visible|focus-within|active|disabled|aria-selected|aria-current|checked|group-hover|dark):/;

/** Components worth naming in a handoff, each with the markup and CSS selector hints that reveal it. */
const COMPONENTS: { name: string; tags: string[]; classHint: RegExp; roles: string[] }[] = [
  { name: "Button", tags: ["button"], classHint: /\b(btn|button|cta)\b/i, roles: ["button"] },
  { name: "Link", tags: ["a"], classHint: /\blink\b/i, roles: ["link"] },
  { name: "Input", tags: ["input", "select", "textarea"], classHint: /\b(input|field|form-control|select)\b/i, roles: ["textbox", "combobox", "searchbox"] },
  { name: "Card", tags: ["article"], classHint: /\b(card|panel|tile)\b/i, roles: [] },
  { name: "Navigation", tags: ["nav", "header"], classHint: /\b(nav|navbar|menu|sidebar|topbar)\b/i, roles: ["navigation", "menubar"] },
  { name: "Tabs", tags: [], classHint: /\btabs?\b/i, roles: ["tab", "tablist"] },
  { name: "Badge", tags: [], classHint: /\b(badge|chip|pill|tag)\b/i, roles: [] },
  { name: "Table", tags: ["table"], classHint: /\btable\b/i, roles: ["table", "grid"] },
  { name: "Dialog", tags: ["dialog"], classHint: /\b(modal|dialog|drawer)\b/i, roles: ["dialog"] },
  { name: "List", tags: ["ul", "ol"], classHint: /\blist\b/i, roles: ["list"] },
  { name: "Footer", tags: ["footer"], classHint: /\bfooter\b/i, roles: ["contentinfo"] },
];
const CSS_STATE_RE = /:(hover|focus-visible|focus-within|focus|active|disabled|checked)\b|\[(aria-selected|aria-current|aria-expanded)[^\]]*\]|\.(active|selected|is-active)\b/g;

function normColor(raw: string): string {
  const c = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : c;
}

function colorBucket(prop: string): keyof DesignTokens["colors"] {
  if (/^background|^bg$/.test(prop)) return "background";
  if (prop === "color" || prop === "text" || prop === "fill") return "text";
  if (/border|outline|ring|divide/.test(prop)) return "border";
  return "other";
}

/** Every CSS source in the page: <style> blocks plus inline style="" attributes. */
function cssSources(html: string): { blocks: string[]; inline: string[] } {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] || "");
  const inline = [...html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? "");
  return { blocks, inline };
}

/** Declarations from a style attribute, or from the rule bodies of a stylesheet (never its selectors). */
function declarations(css: string, isBlock: boolean): [string, string][] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies = isBlock ? [...clean.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] || "") : [clean];
  const out: [string, string][] = [];
  for (const body of bodies) {
    for (const m of body.matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+)/gi)) out.push([(m[1] || "").toLowerCase(), (m[2] || "").trim()]);
  }
  return out;
}

function firstFont(value: string): string {
  const first = value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") || "";
  return /^(inherit|initial|unset|var\()/i.test(first) ? "" : first;
}

/** Read the page's own tokens and components. Pure: exported for tests. */
export function extractDesignTokens(input: string): DesignTokens {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const { blocks, inline } = cssSources(html);
  const buckets = { background: new Counter(), text: new Counter(), border: new Counter(), other: new Counter() };
  const fonts = new Counter();
  const sizes = new Counter();
  const radii = new Counter();
  const spacing = new Counter();
  const shadows = new Counter();
  const variables = new Map<string, string>();

  for (const [prop, value] of [...blocks.flatMap((b) => declarations(b, true)), ...inline.flatMap((b) => declarations(b, false))]) {
    if (prop.startsWith("--")) {
      if (!variables.has(prop) && value.length <= 120) variables.set(prop, value);
      continue;
    }
    for (const c of value.match(COLOR_RE) || []) buckets[colorBucket(prop)].add(normColor(c));
    if (prop === "font-family") fonts.add(firstFont(value));
    else if (prop === "font") fonts.add(firstFont(/(?:^|\s)[\d.]+(?:px|rem|em|pt|%)(?:\/\S+)?\s+(.+)$/.exec(value)?.[1] || ""));
    else if (prop === "font-size") sizes.add(value);
    else if (prop.endsWith("radius")) radii.add(value);
    else if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(prop)) {
      for (const v of value.split(/\s+/)) if (/^-?[\d.]+(px|rem|em)$/.test(v)) spacing.add(v);
    } else if (prop === "box-shadow" && value !== "none") shadows.add(value);
  }

  // Google Fonts links name the families even when the CSS only says var(--font).
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    for (const fam of (m[1] || "").replace(/&amp;/g, "&").matchAll(/family=([^:&]+)/g)) {
      try { fonts.add(decodeURIComponent((fam[1] || "").replace(/\+/g, " "))); } catch { /* malformed escape: skip */ }
    }
  }

  const componentCounts = new Map<string, { count: number; states: Set<string> }>();
  const touch = (name: string) => {
    let entry = componentCounts.get(name);
    if (!entry) { entry = { count: 0, states: new Set() }; componentCounts.set(name, entry); }
    return entry;
  };
  let utilityClasses = false;
  let darkVariant = /prefers-color-scheme:\s*dark|\.dark\b|\[data-theme=["']?dark/i.test(blocks.join("\n"));

  for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = (m[1] || "").toLowerCase();
    if (tag === "style" || tag === "script" || tag === "link" || tag === "meta") continue;
    const attrs = m[2] || "";
    const cls = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const classList = (cls?.[2] ?? cls?.[3] ?? "").split(/\s+/).filter(Boolean);
    const role = /\srole\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1]?.toLowerCase() || "";
    const component = COMPONENTS.find((c) => c.tags.includes(tag) || (role && c.roles.includes(role)) || c.classHint.test(classList.join(" ")));
    const entry = component ? touch(component.name) : null;
    if (entry) entry.count++;
    for (const raw of classList) {
      const state = TW_STATE_RE.exec(raw);
      if (state) {
        utilityClasses = true;
        if (state[1] === "dark") darkVariant = true;
        else entry?.states.add(state[1] || "");
      }
      const base = raw.replace(/^(?:[\w-]+:)+/, "");
      const color = TW_COLOR_RE.exec(base);
      if (color && !TW_TEXT_SIZE_RE.test(base)) {
        utilityClasses = true;
        const arbitrary = /^\[(.+)\]$/.exec(color[2] || "");
        buckets[colorBucket(color[1] || "")].add(arbitrary ? normColor(arbitrary[1] || "") : base);
        continue;
      }
      if (TW_TEXT_SIZE_RE.test(base)) { utilityClasses = true; sizes.add(base); }
      else if (/^rounded(-[\w[\].#%]+)?$/.test(base)) { utilityClasses = true; radii.add(base); }
      else if (TW_SPACING_RE.test(base)) { utilityClasses = true; spacing.add(base); }
      else if (/^shadow(-\w+)?$/.test(base) && base !== "shadow-none") { utilityClasses = true; shadows.add(base); }
      else if (/^font-(sans|serif|mono|\[[^\]]+\])$/.test(base)) { utilityClasses = true; fonts.add(base); }
    }
  }

  // CSS rules attach states to a component when the selector names it (button:hover, .card:focus-within).
  for (const css of blocks) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
      for (const selector of (m[1] || "").split(",")) {
        const states = [...selector.matchAll(CSS_STATE_RE)].map((s) => s[1] || s[2] || s[3] || "").filter(Boolean);
        if (!states.length) continue;
        const bare = selector.replace(CSS_STATE_RE, " ");
        const component = COMPONENTS.find((c) => c.tags.some((t) => new RegExp(`(^|[\\s>+~])${t}\\b`, "i").test(bare)) || c.classHint.test(bare.replace(/[.#]/g, " ")));
        if (component) for (const s of states) touch(component.name).states.add(s);
      }
    }
  }

  return {
    variables: [...variables.entries()].slice(0, 40),
    colors: { background: buckets.background.top(), text: buckets.text.top(), border: buckets.border.top(6), other: buckets.other.top(6) },
    fonts: fonts.top(4),
    fontSizes: sizes.top(10),
    radii: radii.top(6),
    spacing: spacing.top(10),
    shadows: shadows.top(4),
    utilityClasses,
    darkVariant,
    components: [...componentCounts.entries()]
      .map(([name, v]) => ({ name, count: v.count, states: [...v.states].sort() }))
      .filter((c) => c.count > 0 || c.states.length)
      .sort((a, b) => COMPONENTS.findIndex((c) => c.name === a.name) - COMPONENTS.findIndex((c) => c.name === b.name)),
  };
}

/** YAML scalar that survives colons, quotes and hashes in CSS values. */
function yamlStr(value: string): string { return JSON.stringify(value); }
function yamlList(indent: string, key: string, values: string[]): string {
  return values.length ? `${indent}${key}:\n${values.map((v) => `${indent}  - ${yamlStr(v)}`).join("\n")}\n` : `${indent}${key}: []\n`;
}
function inlineList(values: string[]): string { return values.map((v) => `\`${v}\``).join(", "); }

/** Render the DESIGN.md for one chosen output. */
export function buildDesignMd(html: string, source: DesignMdSource): string {
  const t = extractDesignTokens(html);
  const allColors = [...t.colors.background, ...t.colors.text, ...t.colors.border, ...t.colors.other];
  let front = "---\n";
  front += `name: ${yamlStr(source.label)}\n`;
  front += `source: ${yamlStr(source.file)}\n`;
  if (source.runId) front += `run: ${yamlStr(source.runId)}\n`;
  front += `generator: "RēDesign static extraction"\n`;
  front += "colors:\n";
  front += yamlList("  ", "background", t.colors.background);
  front += yamlList("  ", "text", t.colors.text);
  front += yamlList("  ", "border", t.colors.border);
  front += yamlList("  ", "other", t.colors.other);
  front += "typography:\n";
  front += yamlList("  ", "families", t.fonts);
  front += yamlList("  ", "sizes", t.fontSizes);
  front += yamlList("", "radii", t.radii);
  front += yamlList("", "spacing", t.spacing);
  front += yamlList("", "shadows", t.shadows);
  if (t.variables.length) front += `variables:\n${t.variables.map(([k, v]) => `  ${yamlStr(k)}: ${yamlStr(v)}`).join("\n")}\n`;
  front += "---\n";

  const lines: string[] = [front, `# DESIGN.md - ${source.label}`, ""];
  lines.push(
    "Handoff for reproducing this redesign in a real codebase. The front matter holds the tokens read from the",
    "mockup, most frequent first; the sections below say how they are used.",
    "",
    "## Components",
    "",
  );
  if (t.components.length) {
    for (const c of t.components) {
      lines.push(`- **${c.name}** (${c.count} in the mockup) - states: ${c.states.length ? inlineList(c.states) : "none styled"}`);
    }
  } else {
    lines.push("- No recognisable components (buttons, inputs, cards, navigation) were found in the markup.");
  }

  const dos: string[] = [];
  const donts: string[] = [];
  if (t.variables.length) dos.push("Start from the CSS custom properties under `variables`; the mockup defines its theme there.");
  if (allColors.length) {
    dos.push(`Take colours from the front matter: backgrounds ${inlineList(t.colors.background.slice(0, 3)) || "(none found)"}, text ${inlineList(t.colors.text.slice(0, 3)) || "(none found)"}.`);
    donts.push("Don't hard-code a colour that is not in the front matter; add it to the tokens first so the palette stays closed.");
  }
  if (t.fonts.length) {
    dos.push(`Set type in ${inlineList(t.fonts)}${t.fontSizes.length ? ` on the size scale ${inlineList(t.fontSizes.slice(0, 6))}` : ""}.`);
    donts.push("Don't introduce another font family or an off-scale font size.");
  }
  if (t.radii.length) {
    dos.push(`Round corners with ${inlineList(t.radii.slice(0, 3))}; the most frequent one is the default.`);
    donts.push("Don't mix sharp and rounded corners on the same kind of component.");
  }
  if (t.spacing.length) dos.push(`Space on the scale ${inlineList(t.spacing.slice(0, 6))}.`);
  if (t.shadows.length) dos.push(`Keep elevation to ${inlineList(t.shadows.slice(0, 2))}.`);
  const stateful = t.components.filter((c) => c.states.length);
  if (stateful.length) donts.push(`Don't drop the styled states listed under Components (${stateful.map((c) => c.name).join(", ")}).`);
  if (t.utilityClasses) dos.push("The mockup uses utility classes (Tailwind-style names); map them to the target app's own utilities or tokens rather than pasting them.");

  lines.push("", "## Do's", "", ...(dos.length ? dos.map((d) => `- ${d}`) : ["- No tokens were found to derive rules from."]));
  lines.push("", "## Don'ts", "", ...(donts.length ? donts.map((d) => `- ${d}`) : ["- None derived."]));

  const gaps = [
    "Read statically from the HTML: styles applied by scripts, images and canvas, and a utility framework's default theme values are not resolved (utility class names are listed as-is).",
    "Rules above are derived from token frequency, not reviewed by a model or a person.",
  ];
  const interactive = t.components.filter((c) => ["Button", "Link", "Input", "Tabs"].includes(c.name));
  if (interactive.length && !interactive.some((c) => c.states.some((s) => s.startsWith("focus")))) gaps.push("No focus style was found on interactive components; add a visible focus ring before shipping.");
  if (!t.darkVariant) gaps.push("No dark-mode variant was found; the mockup defines one theme only.");
  if (!t.fonts.length) gaps.push("No font family was declared; the mockup falls back to the browser default.");
  lines.push("", "## Known Gaps", "", ...gaps.map((g) => `- ${g}`), "");
  return lines.join("\n");
}

/**
 * Anti-slop lint: a deterministic rule table run over each model's generated HTML.
 *
 * WHY: a fan-out shows every model's answer as is, and a fair share of them fall back on the same
 * generic AI styling (purple gradients, emoji icons, "unlock the power of" copy). Those patterns
 * are cheap to spot in the markup itself, so each output is scored here for free, the gallery
 * shows the score as a badge, and a P0 finding earns that one job a single re-prompt (see
 * retrySloppyOutput in job-worker.ts). No network, no model call: regexes over the saved HTML.
 *
 * The rule set follows the idea of nexu-io/open-design's artifact linter (Apache-2.0); this is a
 * fresh implementation for ReDesign, not a copy of it.
 *
 * Severity: P0 = generic enough to be worth one paid retry, P1 = worth a look, P2 = advisory.
 */

type SlopSeverity = "P0" | "P1" | "P2";

type SlopRuleId =
  | "purple-gradient"
  | "trust-gradient"
  | "ai-default-indigo"
  | "emoji-icon"
  | "sans-display"
  | "invented-metric"
  | "filler-copy"
  | "raw-hex"
  | "accent-overuse"
  | "all-caps-no-tracking"
  | "external-image";

interface SlopFinding {
  rule: SlopRuleId;
  severity: SlopSeverity;
  message: string;
  /** A short excerpt of what matched, so a reader (or the retried model) can find it. */
  snippet: string;
}

/** What a job carries: counts per severity plus the findings themselves (capped). */
interface SlopSummary {
  p0: number;
  p1: number;
  p2: number;
  findings: SlopFinding[];
}

interface LintOptions {
  /** The grounding caption of the original screenshot. Numbers and phrases found in it are real
   *  content, not invention, so invented-metric and filler-copy skip them. */
  sourceText?: string | null;
}

interface CssRule {
  selector: string;
  body: string;
}

/** Everything the rules read, parsed once per document. */
interface LintDoc {
  css: string;
  rules: CssRule[];
  classLists: string[];
  textNodes: string[];
  html: string;
  source: string;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

type RuleHit = { message: string; snippet: string; severity?: SlopSeverity };

interface SlopRule {
  id: SlopRuleId;
  severity: SlopSeverity;
  title: string;
  check: (doc: LintDoc) => RuleHit[];
}

// --- parsing -------------------------------------------------------------------------

function clip(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
}

function parseDoc(html: string, source: string): LintDoc {
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] || "");
  const styleAttrs = [...html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => decodeEntities(m[2] ?? m[3] ?? ""));
  const sheet = styleBlocks.join("\n").replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules: CssRule[] = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] || "").trim(), body: m[2] || "" }));
  for (const body of styleAttrs) rules.push({ selector: "[style]", body });
  const classLists = [...html.matchAll(/\sclass(?:Name)?\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? "");
  const visible = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  const textNodes = visible
    .split(/<[^>]*>/)
    .map((t) => decodeEntities(t).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { css: `${sheet}\n${styleAttrs.join("\n")}`, rules, classLists, textNodes, html, source: normalizeForCompare(source) };
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s,]/g, "");
}

// --- colour --------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  purple: "#800080",
  violet: "#ee82ee",
  indigo: "#4b0082",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  blueviolet: "#8a2be2",
  darkviolet: "#9400d3",
  mediumpurple: "#9370db",
  rebeccapurple: "#663399",
  blue: "#0000ff",
  royalblue: "#4169e1",
  dodgerblue: "#1e90ff",
  deepskyblue: "#00bfff",
  cyan: "#00ffff",
  aqua: "#00ffff",
};

const COLOR_RE = new RegExp(`#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|\\b(?:${Object.keys(NAMED).join("|")})\\b`, "gi");
const HEX_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hexToHsl(hex: string): Hsl | null {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  else h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return rgbToHsl(Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16));
}

function toHsl(token: string): Hsl | null {
  const t = token.toLowerCase();
  if (t.startsWith("#")) return hexToHsl(t);
  if (NAMED[t]) return hexToHsl(NAMED[t] as string);
  const rgb = t.match(/^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/);
  if (rgb) {
    const ch = (v: string | undefined, pct: string | undefined) => (pct ? Number(v) * 2.55 : Number(v));
    return rgbToHsl(ch(rgb[1], rgb[2]), ch(rgb[3], rgb[4]), ch(rgb[5], rgb[6]));
  }
  const hsl = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (hsl) return { h: Number(hsl[1]) % 360, s: Number(hsl[2]) / 100, l: Number(hsl[3]) / 100 };
  return null;
}

const isPurple = (c: Hsl) => c.h >= 255 && c.h <= 320 && c.s >= 0.3 && c.l >= 0.15 && c.l <= 0.9;
const isBlue = (c: Hsl) => c.h >= 205 && c.h < 250 && c.s >= 0.4 && c.l >= 0.2 && c.l <= 0.85;
const isCyan = (c: Hsl) => c.h >= 170 && c.h < 205 && c.s >= 0.4 && c.l >= 0.2 && c.l <= 0.85;

/** Every CSS gradient in the document, each with its full (paren-balanced) argument list. */
function cssGradients(css: string): string[] {
  const out: string[] = [];
  const re = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
  let m: RegExpExecArray | null = re.exec(css);
  while (m) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")") depth--;
    }
    out.push(css.slice(m.index, i));
    re.lastIndex = i;
    m = re.exec(css);
  }
  return out;
}

function gradientColors(gradient: string): Hsl[] {
  return [...gradient.matchAll(COLOR_RE)].map((m) => toHsl(m[0])).filter((c): c is Hsl => c !== null);
}

/** Tailwind gradient stops (from-/via-/to-<hue>-<shade>) per class list that draws a gradient. */
function tailwindGradientStops(classLists: string[]): { classes: string; hues: string[] }[] {
  const out: { classes: string; hues: string[] }[] = [];
  for (const classes of classLists) {
    if (!/\bbg-(?:gradient-to|linear-to|radial|conic)\b|\bbg-(?:linear|radial|conic)-/.test(classes)) continue;
    const hues = [...classes.matchAll(/\b(?:from|via|to)-([a-z]+)-\d{2,3}\b/g)].map((m) => m[1] as string);
    if (hues.length) out.push({ classes, hues });
  }
  return out;
}

// --- rules ---------------------------------------------------------------------------

const GENERIC_SANS = new Set(["inter", "roboto", "arial", "helvetica", "helvetica neue", "system-ui", "-apple-system", "blinkmacsystemfont", "segoe ui", "open sans", "sans-serif", "ui-sans-serif"]);

function firstFamily(body: string): string | null {
  const m = body.match(/font-family\s*:\s*([^;]+)/i);
  if (!m) return null;
  return (m[1] || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "").toLowerCase() || null;
}

// Emoji_Presentation (not Extended_Pictographic) so text-style glyphs like arrows and (c) stay legal.
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/gu;
const EMOJI_ONE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u; // non-global: .test() without lastIndex state

const FILLER_PHRASES = [
  "unlock the power",
  "seamless",
  "revolutioniz",
  "supercharge",
  "elevate your",
  "cutting-edge",
  "next-generation",
  "next-gen",
  "game-chang",
  "effortless",
  "to the next level",
  "unleash",
  "empower",
  "streamline your",
  "all-in-one platform",
  "your tagline",
  "welcome to our",
];

const METRIC_RE =
  /(?:[$€£]\s?\d[\d,.]*\s?[kmb]?\+?|\b\d[\d,.]*\s?(?:%|[kmb]\+|\+|x(?!\w))|\b\d(?:\.\d+)?\s?\/\s?5\b|\b\d[\d,.]*\s?[kmb]?\+?\s(?:users|customers|teams|companies|downloads|reviews|countries|developers|businesses)\b)/gi;

const SLOP_RULES: readonly SlopRule[] = [
  {
    id: "purple-gradient",
    severity: "P0",
    title: "Purple/violet gradient",
    check: (doc) => {
      const css = cssGradients(doc.css).find((g) => gradientColors(g).some(isPurple));
      if (css) return [{ message: "a purple or violet gradient, the default AI hero look", snippet: clip(css) }];
      const tw = tailwindGradientStops(doc.classLists).find((s) => s.hues.some((h) => h === "purple" || h === "violet" || h === "fuchsia"));
      return tw ? [{ message: "a purple or violet gradient, the default AI hero look", snippet: clip(tw.classes) }] : [];
    },
  },
  {
    id: "trust-gradient",
    severity: "P0",
    title: "Blue-to-cyan trust gradient",
    check: (doc) => {
      const css = cssGradients(doc.css).find((g) => {
        const colors = gradientColors(g);
        return colors.some(isBlue) && colors.some(isCyan);
      });
      if (css) return [{ message: "a blue-to-cyan 'trust' gradient", snippet: clip(css) }];
      const tw = tailwindGradientStops(doc.classLists).find((s) => s.hues.some((h) => h === "blue" || h === "indigo") && s.hues.some((h) => h === "cyan" || h === "sky" || h === "teal"));
      return tw ? [{ message: "a blue-to-cyan 'trust' gradient", snippet: clip(tw.classes) }] : [];
    },
  },
  {
    id: "ai-default-indigo",
    severity: "P1",
    title: "Tailwind's default indigo as the brand colour",
    check: (doc) => {
      const hex = [...doc.css.matchAll(/#(?:6366f1|4f46e5|4338ca|818cf8|a5b4fc)\b/gi)].map((m) => m[0]);
      const tw = doc.classLists.flatMap((c) => [...c.matchAll(/\b(?:bg|text|border|from|via|to|ring|fill|stroke|shadow|outline|decoration|accent)-indigo-\d{2,3}\b/g)].map((m) => m[0]));
      const hits = [...hex, ...tw];
      return hits.length >= 2 ? [{ message: `Tailwind's stock indigo used ${hits.length} times as the accent`, snippet: clip([...new Set(hits)].join(" ")) }] : [];
    },
  },
  {
    id: "emoji-icon",
    severity: "P0",
    title: "Emoji standing in for icons",
    check: (doc) => {
      const icons = doc.textNodes.filter((t) => EMOJI_ONE.test(t) && t.replace(EMOJI_RE, "").replace(/[\s‍️]/g, "") === "");
      if (icons.length >= 2) return [{ message: `${icons.length} emoji used as icons`, snippet: clip(icons.slice(0, 8).join(" ")) }];
      if (icons.length === 1) return [{ message: "an emoji used as an icon", snippet: clip(icons[0] as string), severity: "P1" }];
      return [];
    },
  },
  {
    id: "sans-display",
    severity: "P1",
    title: "Display type in a default sans",
    check: (doc) => {
      const heading = doc.rules.find((r) => /(?:^|[\s,>+~])h[12]\b|hero|display|headline/i.test(r.selector) && GENERIC_SANS.has(firstFamily(r.body) || ""));
      if (heading) return [{ message: "headings set in a default sans with no display face", snippet: clip(`${heading.selector} { ${heading.body.match(/font-family\s*:[^;]+/i)?.[0] ?? ""} }`) }];
      const families = new Set(doc.rules.map((r) => firstFamily(r.body)).filter((f): f is string => !!f));
      const only = families.size === 1 ? [...families][0] : null;
      return only && GENERIC_SANS.has(only) ? [{ message: `one default sans (${only}) for everything, display type included`, snippet: `font-family: ${only}`, severity: "P2" }] : [];
    },
  },
  {
    id: "invented-metric",
    severity: "P1",
    title: "Metrics the original never showed",
    check: (doc) => {
      if (!doc.source) return []; // without the grounding caption there is nothing to compare against
      const invented = new Set<string>();
      for (const m of doc.textNodes.join(" \n ").matchAll(METRIC_RE)) {
        const core = (m[0].match(/\d[\d,.]*/)?.[0] || "").replace(/,/g, "").replace(/\.$/, "");
        if (core && !doc.source.includes(core)) invented.add(m[0].trim());
      }
      return invented.size ? [{ message: `${invented.size} figure(s) not in the original screenshot`, snippet: clip([...invented].slice(0, 6).join(", ")) }] : [];
    },
  },
  {
    id: "filler-copy",
    severity: "P1",
    title: "Filler or marketing-template copy",
    check: (doc) => {
      const text = doc.textNodes.join(" ");
      const lower = text.toLowerCase();
      const lorem = lower.indexOf("lorem ipsum");
      if (lorem >= 0) return [{ message: "placeholder lorem ipsum text", snippet: clip(text.slice(lorem, lorem + 80)), severity: "P0" }];
      const found = FILLER_PHRASES.filter((p) => lower.includes(p) && !doc.source.includes(normalizeForCompare(p)));
      return found.length ? [{ message: `template marketing phrases: ${found.join(", ")}`, snippet: clip(found.map((p) => text.slice(lower.indexOf(p), lower.indexOf(p) + 40)).join(" | ")) }] : [];
    },
  },
  {
    id: "raw-hex",
    severity: "P2",
    title: "Raw hex colours instead of tokens",
    check: (doc) => {
      const tokenDefs = (doc.css.match(/--[\w-]+\s*:/g) || []).length;
      const outsideTokens = doc.css.replace(/--[\w-]+\s*:[^;}]*/g, " ");
      const arbitrary = doc.classLists.join(" ").match(/\[#[0-9a-f]{3,8}\]/gi) || [];
      const raw = new Set([...(outsideTokens.match(HEX_RE) || []), ...arbitrary].map((h) => h.toLowerCase()));
      const limit = tokenDefs ? 10 : 6;
      return raw.size >= limit ? [{ message: `${raw.size} distinct raw hex colours${tokenDefs ? " outside the defined tokens" : " and no colour tokens"}`, snippet: clip([...raw].slice(0, 8).join(" ")) }] : [];
    },
  },
  {
    id: "accent-overuse",
    severity: "P2",
    title: "One accent colour on everything",
    check: (doc) => {
      const counts = new Map<string, number>();
      for (const m of doc.css.matchAll(HEX_RE)) {
        const hex = m[0].toLowerCase();
        const c = hexToHsl(hex);
        if (c && c.s >= 0.55 && c.l >= 0.25 && c.l <= 0.75) counts.set(hex, (counts.get(hex) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return top && top[1] >= 12 ? [{ message: `accent ${top[0]} applied ${top[1]} times`, snippet: top[0] }] : [];
    },
  },
  {
    id: "all-caps-no-tracking",
    severity: "P2",
    title: "All caps without letter-spacing",
    check: (doc) => {
      const css = doc.rules.filter((r) => /text-transform\s*:\s*uppercase/i.test(r.body) && !/letter-spacing\s*:\s*(?!0[;\s]|0$|normal)/i.test(r.body));
      const tw = doc.classLists.filter((c) => /(?:^|\s)uppercase(?:\s|$)/.test(c) && !/\btracking-/.test(c));
      const n = css.length + tw.length;
      return n ? [{ message: `${n} uppercase style(s) with no letter-spacing`, snippet: clip(css[0] ? css[0].selector : (tw[0] as string)) }] : [];
    },
  },
  {
    id: "external-image",
    severity: "P1",
    title: "Images pulled from another host",
    check: (doc) => {
      const hosts = new Set<string>();
      for (const m of doc.html.matchAll(/<img\b[^>]*\s(?:src|srcset)\s*=\s*["']?\s*(https?:\/\/[^\s"'>]+)/gi)) hosts.add(hostOf(m[1] as string));
      for (const m of doc.css.matchAll(/url\(\s*["']?(https?:\/\/[^)"'\s]+)/gi)) hosts.add(hostOf(m[1] as string));
      return hosts.size ? [{ message: "images loaded from an external host (stock or placeholder art)", snippet: clip([...hosts].join(", ")) }] : [];
    },
  },
];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 60);
  }
}

// --- API -----------------------------------------------------------------------------

/** Run every rule over one HTML document. Deterministic; never throws on malformed markup. */
function lintHtml(html: string, opts: LintOptions = {}): SlopFinding[] {
  const doc = parseDoc(String(html || ""), String(opts.sourceText || ""));
  const findings: SlopFinding[] = [];
  for (const rule of SLOP_RULES) {
    let hits: RuleHit[] = [];
    try {
      hits = rule.check(doc);
    } catch {
      hits = []; // a lint rule must never cost the job its output
    }
    for (const hit of hits) findings.push({ rule: rule.id, severity: hit.severity || rule.severity, message: hit.message, snippet: hit.snippet });
  }
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function summarizeSlop(findings: SlopFinding[]): SlopSummary {
  const count = (s: SlopSeverity) => findings.filter((f) => f.severity === s).length;
  return { p0: count("P0"), p1: count("P1"), p2: count("P2"), findings: findings.slice(0, 12) };
}

/** The prompt block that sends P0 findings back to the model for its one retry. */
function slopFixBlock(findings: SlopFinding[]): string {
  const lines = findings.filter((f) => f.severity === "P0").map((f) => `- ${f.rule}: ${f.message}${f.snippet ? ` (found: ${f.snippet})` : ""}`);
  return `\n\n--- A style check of your previous answer to this same request flagged these generic AI-design patterns. Produce the complete redesign again, keep the real content and everything else the request asks for, and avoid each of them: ---\n${lines.join("\n")}`;
}

/** Retries are on by default; REDESIGN_NO_SLOP_RETRY=1 keeps the lint and the badge but never re-prompts. */
function slopRetryEnabled(): boolean {
  return process.env.REDESIGN_NO_SLOP_RETRY !== "1";
}

export { lintHtml, SLOP_RULES, slopFixBlock, slopRetryEnabled, summarizeSlop };
export type { SlopFinding, SlopRuleId, SlopSeverity, SlopSummary };

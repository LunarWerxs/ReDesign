#!/usr/bin/env node
/**
 * i18n compliance check for the Reimagine web UI. Node-only (no Bun): the English
 * catalog is a `.ts` file, so it's loaded via the TypeScript compiler API rather
 * than a bare import. Run: `npm run check:i18n` (also gates `npm run build`).
 *
 * Fails (exit 1) on:
 *   1. MISSING KEY, a t()/$t('x') reference in source with no entry in en.ts.
 *   2. HARDCODED, user-facing prose in a template (text node or placeholder/
 *                        title/aria-label/alt attribute) or a toast() literal not run
 *                        through t(). Put `<!-- i18n-ignore -->` immediately before a
 *                        node to exempt it (and its subtree).
 * Warns (does not fail) on UNUSED keys present in en.ts but never referenced.
 *
 * Templates are parsed with @vue/compiler-sfc (real AST), so the hardcoded-string
 * scan is accurate. Kit-synced dirs (components/ui, shell) are exempt library code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import ts from "typescript";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(WEB, "src");
const LOCALES = join(SRC, "i18n", "locales");
const EN = join(LOCALES, "en.ts");
// Vendored shadcn / LunarWerx-kit primitives + shared shell are library code, not
// app copy, their sr-only labels are intentionally hardcoded and synced from the kit.
const UI = join(SRC, "components", "ui");
const SHELL = join(SRC, "shell");

// Static prose attributes that should be translated when set to a literal.
const PROSE_ATTRS = new Set(["placeholder", "title", "aria-label", "alt", "aria-description"]);
// Elements whose text content is never UI prose.
const SKIP_TEXT_TAGS = new Set(["code", "pre", "style", "script"]);
// Literal text allowed to stay hardcoded (brand / symbols / technical, non-translatable).
const TEXT_ALLOWLIST = new Set(["RēDesign", "·", ", ", "/", "×", "AI", "↑", "↓"]);

const errors = [];
const warnings = [];
const rel = (p) => relative(WEB, p).replace(/\\/g, "/");

// ── load + flatten en.ts (via the TS compiler API, then eval as CommonJS) ──────────
function loadEn() {
  const src = readFileSync(EN, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", js)(mod, mod.exports);
  return mod.exports.default ?? mod.exports;
}
const flatten = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const enKeys = new Set(Object.keys(flatten(loadEn())));

// ── walk source files ─────────────────────────────────────────────────────────────
const walkDir = (dir, files = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || p === LOCALES || p === UI || p === SHELL) continue;
      walkDir(p, files);
    } else if ([".vue", ".ts"].includes(extname(p))) {
      files.push(p);
    }
  }
  return files;
};
const sourceFiles = walkDir(SRC);

// ── 1. collect t()/$t() key references (negative lookbehind avoids `.at(`, `format(`) ──
const referenced = new Set();
const KEY_RE = /(?<![\w$])\$?t\(\s*(['"`])([\w.]+)\1/g;
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(KEY_RE)) {
    referenced.add(m[2]);
    if (!enKeys.has(m[2])) errors.push(`MISSING KEY   ${rel(file)} → t('${m[2]}') has no entry in en.ts`);
  }
}

// ── 2. hardcoded-string scan (templates via AST + toast literals) ───────────────────
const hasLetter = (s) => /\p{L}/u.test(s);
const flagText = (raw, file, line) => {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || !hasLetter(text) || TEXT_ALLOWLIST.has(text)) return;
  errors.push(`HARDCODED     ${rel(file)}:${line} → template text "${text.slice(0, 60)}"`);
};
const isIgnore = (n) => n && n.type === 3 && String(n.content).trim().toLowerCase() === "i18n-ignore";
const walkChildren = (children, file, tag) => {
  for (let i = 0; i < (children?.length ?? 0); i++) {
    if (isIgnore(children[i - 1])) continue; // skip node (and its subtree) after an i18n-ignore
    walkNode(children[i], file, tag);
  }
};
// A string literal "looks like prose" if it contains whitespace or ends with
// sentence punctuation, used to flag display text hidden inside an interpolation
// expression (e.g. `{{ ok ? 'Saved' : '' }}`) while ignoring identifier-ish keys.
const looksLikeProse = (s) => /\p{L}/u.test(s) && (/\s/.test(s) || /[....!?:]$/.test(s));
const flagExprLiterals = (expr, file, line) => {
  for (const m of expr.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const lit = m[2];
    // `${...}` chunks are composed code (usually t() calls joined by separators), not static prose.
    if (lit.includes("${")) continue;
    if (looksLikeProse(lit) && !TEXT_ALLOWLIST.has(lit.trim())) {
      warnings.push(`IN-EXPR       ${rel(file)}:${line} → prose literal in expression "${lit.slice(0, 50)}", verify it isn't UI copy`);
    }
  }
};
const walkNode = (node, file, parentTag) => {
  if (!node) return;
  switch (node.type) {
    case 2: // TEXT
      if (!SKIP_TEXT_TAGS.has(parentTag)) flagText(node.content, file, node.loc?.start?.line ?? 0);
      return;
    case 5: // INTERPOLATION, {{ expr }}
      flagExprLiterals(node.content?.content ?? "", file, node.loc?.start?.line ?? 0);
      return;
    case 1: // ELEMENT
      for (const prop of node.props || []) {
        if (prop.type === 6 && PROSE_ATTRS.has(prop.name)) {
          const v = prop.value?.content ?? "";
          if (hasLetter(v) && !TEXT_ALLOWLIST.has(v.trim())) {
            errors.push(`HARDCODED     ${rel(file)}:${prop.loc?.start?.line ?? 0} → ${prop.name}="${v}"`);
          }
        }
      }
      walkChildren(node.children, file, node.tag);
      return;
    case 9: // IF
      for (const b of node.branches || []) walkChildren(b.children, file, parentTag);
      return;
    default: // ROOT / FOR / IF_BRANCH / etc.
      walkChildren(node.children, file, parentTag);
  }
};
const TOAST_RE = /toast\.(?:success|error|info|warning|message)?\(\s*(['"`])((?:(?!\1).)*?\p{L}{2,}(?:(?!\1).)*?)\1/gu;
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  if (extname(file) === ".vue") {
    const { descriptor } = parse(src, { filename: file });
    if (descriptor.template?.ast) walkChildren(descriptor.template.ast.children, file, "template");
  }
  for (const m of src.matchAll(TOAST_RE)) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    errors.push(`HARDCODED     ${rel(file)}:${lineNo} → toast literal "${m[2].slice(0, 50)}"`);
  }
}

// ── 3. unused keys (warn only) ──────────────────────────────────────────────────────
for (const k of enKeys) if (!referenced.has(k)) warnings.push(`UNUSED KEY    en.ts '${k}' is never referenced`);

// ── report ──────────────────────────────────────────────────────────────────────────
console.log(`i18n-check · ${sourceFiles.length} source files · ${enKeys.size} keys · ${referenced.size} referenced · locales: en`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
if (errors.length === 0) {
  console.log(`\n✓ i18n compliant (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
  process.exit(0);
}
console.error(`\n✗ ${errors.length} i18n problem${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  ${e}`);
process.exit(1);

// Shared small helpers for the runner: the process-wide KeyManager singleton,
// env-config parsing, captioning/labeling prompt text, and the prompt-text
// helpers used to splice style-reference instructions into a job's prompt.

import { KeyManager } from "../keyManager";

// One shared KeyManager per process so cooldowns/health persist across runs.
let _km: KeyManager | null = null;
function getKeyManager(): KeyManager {
  if (!_km) _km = new KeyManager();
  return _km;
}

function cfgInt(name: string, def: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

// Prompt used to caption a screenshot for text-only models (e.g. DeepSeek),
// which can't take images. The caption is fed to them so they can still
// reimagine the real UI instead of inventing a generic one.
const DESCRIBE_PROMPT =
  "Describe this UI screenshot in thorough, concrete detail so a designer who cannot see it could faithfully recreate AND reimagine it. Cover: the screen's purpose, every section and component, all visible text/labels, layout and hierarchy, spacing, colors and theme, and any states (selected, expanded, disabled). Output plain text only, no preamble.";

// Prompt used to caption a STYLE reference image for text-only models, so they
// can absorb its aesthetic direction without seeing it.
const DESCRIBE_REF_PROMPT =
  "Describe the VISUAL STYLE of this image so a designer who cannot see it could borrow its aesthetic direction: overall mood and feel, color palette, typography, spacing/density, shape language (corners, depth, borders), and any distinctive design motifs. Focus on style, not on transcribing content. Output plain text only, no preamble.";

// Tiny manifest label used by the control panel / viewer so runs don't appear
// only as timestamp IDs.
const SHORT_LABEL_PROMPT =
  "Look at this UI screenshot and describe what it is in 3 to 7 words. Output only a short noun phrase, no punctuation, no preamble.";

function cleanRunTitle(text: unknown): string {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[\s"'`*_#-]+|[\s"'`*_#.,:;!-]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

// Mock runs skip the AI naming call (to spend no quota), so give them a stable,
// distinct codename derived from the runId instead of repeating the input name.
const CODENAME_ADJ = ["Cosmic", "Velvet", "Neon", "Quiet", "Golden", "Crimson", "Lunar", "Amber", "Electric", "Frosted", "Marble", "Solar", "Hidden", "Brisk", "Gilded", "Coral"];
const CODENAME_NOUN = ["Falcon", "Harbor", "Lantern", "Comet", "Atlas", "Cypress", "Mirage", "Beacon", "Maple", "Orbit", "Quartz", "Summit", "Willow", "Cobalt", "Meadow", "Tundra"];
function codename(seed: unknown): string {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `${CODENAME_ADJ[h % CODENAME_ADJ.length]} ${CODENAME_NOUN[Math.floor(h / CODENAME_ADJ.length) % CODENAME_NOUN.length]}`;
}

// Instruction appended for VISION models: the reference image(s) ride along at
// the end of the image list and must be read as style direction, not as another
// view of the product to reproduce. (Anthropic/OpenAI/Gemini all preserve image
// order, so "the final N image(s)" is an unambiguous, cross-provider reference.)
function visionReferenceBlock(n: number, note?: string | null): string {
  const plural = n > 1;
  return (
    "\n\n--- STYLE REFERENCE ---\n" +
    `In addition to the screenshot(s) of the product above, the FINAL ${n} image${plural ? "s" : ""} ` +
    `${plural ? "are a" : "is a"} separate visual REFERENCE, NOT part of the product and NOT another view of it. ` +
    `Do not copy ${plural ? "their" : "its"} content or treat ${plural ? "them" : "it"} as a screen to reimagine. ` +
    `Instead, draw stylistic direction from ${plural ? "them" : "it"} (overall aesthetic, layout feel, color, typography, spacing, mood) ` +
    "and apply that direction to your reimagining of the product." +
    (note ? `\nThe user's note about the reference: ${note}` : "")
  );
}

// Same intent for TEXT-ONLY models, which get a described reference instead.
function textReferenceBlock(refCaption: unknown, note?: string | null): string {
  return (
    "\n\n--- STYLE REFERENCE (described, since you cannot see it) ---\n" +
    `Apply the aesthetic/style direction below to your reimagining, do NOT reproduce its content:\n${refCaption}` +
    (note ? `\nThe user's note about the reference: ${note}` : "")
  );
}

export {
  getKeyManager,
  cfgInt,
  DESCRIBE_PROMPT,
  DESCRIBE_REF_PROMPT,
  SHORT_LABEL_PROMPT,
  cleanRunTitle,
  codename,
  visionReferenceBlock,
  textReferenceBlock,
};

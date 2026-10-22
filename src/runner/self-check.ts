/**
 * The optional self-check pass: a model looks at what it just produced before the owner does.
 *
 * WHY: a run is one shot per model and nothing ever looks at the result, so a broken layout, a
 * phone-width overflow or a dropped section goes straight into the gallery. With the per-run
 * `selfCheck` setting on, runner/job-worker.ts renders each successful output headless at a
 * desktop and a phone width, then sends ONE follow-up call carrying the original screenshot, both
 * renders and the model's own HTML, asking for the corrected document.
 *
 * Idea adapted from abi/screenshot-to-code's screenshot_preview tool (MIT); nothing is copied from
 * it. This module owns the rendering and the prompt; the call itself reuses the job worker's key
 * rotation, cost ledger and output writer.
 */
import path from "node:path";
import type { LoadedImage } from "../inputResolver";
import { renderHtmlToPng } from "../thumbnail";
import { imageToBase64 } from "../util";

/** Desktop first, then phone: the order the prompt describes them in. */
export const SELF_CHECK_VIEWPORTS = [
  { name: "desktop", label: "desktop, 1440px wide", width: 1440, height: 900, mobile: false },
  { name: "phone", label: "phone, 390px wide", width: 390, height: 844, mobile: true },
] as const;

/**
 * Larger drafts are not sent back: the follow-up call would carry the whole document twice (in and
 * out), which is where a max-tokens truncation turns a working page into a broken one.
 */
export const MAX_SELF_CHECK_HTML_CHARS = 150_000;

/** What the pass did for one job, kept on the job so the gallery and the manifest can say so. */
export interface SelfCheckOutcome {
  status: "revised" | "kept" | "skipped";
  /** Why a pass was skipped or its revision discarded. */
  reason?: string;
  /** Run-output-relative paths of the renders the model was shown (forward slashes). */
  captures?: string[];
  ms?: number;
  /** Cost of the follow-up call alone; `job.cost` stays the first generation's, like any other job. */
  costUsd?: number | null;
}

/** The capture file for one viewport, beside the output it shows. */
export function selfCheckCapturePath(outputHtml: string, viewport: string): string {
  return `${outputHtml.replace(/\.html$/i, "")}.check-${viewport}.png`;
}

/**
 * Render `outputHtml` full-page at every self-check viewport; rejects if any render fails.
 * `assetRoot` (the run dir) lets the page load its cropped logos from ../assets/crops/.
 */
export async function captureSelfCheck(outputHtml: string, assetRoot?: string): Promise<{ images: LoadedImage[]; files: string[] }> {
  const images: LoadedImage[] = [];
  const files: string[] = [];
  for (const viewport of SELF_CHECK_VIEWPORTS) {
    const png = selfCheckCapturePath(outputHtml, viewport.name);
    await renderHtmlToPng(outputHtml, png, { width: viewport.width, height: viewport.height, fullPage: true, mobile: viewport.mobile }, { assetRoot });
    images.push({ ...imageToBase64(png), file: png });
    files.push(png);
  }
  return { images, files };
}

/**
 * The follow-up instruction. `originalCount` is how many images of the product come first; the
 * renders sit right after them, so a style reference keeps its "final N images" position.
 */
export function selfCheckBlock(previousHtml: string, originalCount: number): string {
  const first = originalCount + 1;
  const originals = originalCount === 1 ? "Image 1 is the original screenshot" : `Images 1-${originalCount} are the original screenshots`;
  const views = SELF_CHECK_VIEWPORTS.map((viewport, i) => `image ${first + i} (${viewport.label})`).join(" and ");
  return (
    "\n\n--- SELF-CHECK: REVIEW AND FIX YOUR OWN OUTPUT ---\n" +
    "You already answered the request above with the HTML document below. " +
    `${originals}. Right after ${originalCount === 1 ? "it" : "them"} come full-page renders of YOUR HTML: ${views}.\n` +
    "Compare the renders with the original and with the request, and fix what is wrong: broken or overlapping layout, " +
    "horizontal overflow or cramped text at phone width, sections or real content from the original that are missing, " +
    "unreadable contrast, empty or collapsed areas, and anything that plainly failed to render. " +
    "Keep the design direction you chose; this is a correction, not a new design. If nothing needs fixing, return the same document.\n" +
    "Reply with the complete corrected HTML document only, following the same output rules as before.\n" +
    "--- YOUR PREVIOUS HTML ---\n" +
    previousHtml +
    "\n--- END OF YOUR PREVIOUS HTML ---"
  );
}

/** The follow-up image list: product screenshots, then the renders, then any style reference. */
export function selfCheckImages(images: LoadedImage[], referenceCount: number, captures: LoadedImage[]): { images: LoadedImage[]; originalCount: number } {
  const originalCount = Math.max(0, images.length - referenceCount);
  return { images: [...images.slice(0, originalCount), ...captures, ...images.slice(originalCount)], originalCount };
}

/** Forward-slash path of `abs` relative to the outputs root, the form job.file uses. */
export function outputRel(outputRoot: string, abs: string): string {
  return path.relative(outputRoot, abs).split(path.sep).join("/");
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWindowSizeHint } from "@/lib/window-size-hint";

// Runs the REAL applier against a fully faked window (via vi.stubGlobal), so its resizeTo /
// off-screen clamp / param-strip / standalone-gate behavior is exercised as actual code, not
// just typechecked. The applier only touches globals inside the function, so replacing
// `window` wholesale is enough; a real Chromium --app forwarded launch stays a manual check.
type FakeOpts = {
  search: string;
  standalone?: boolean;
  outerWidth?: number;
  outerHeight?: number;
  screenX?: number;
  screenY?: number;
};

function stubWindow(opts: FakeOpts) {
  const resizeTo = vi.fn();
  const moveTo = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { search: opts.search, pathname: "/", hash: "" },
    matchMedia: (media: string) => ({ matches: opts.standalone ?? true, media }),
    outerWidth: opts.outerWidth ?? 1280,
    outerHeight: opts.outerHeight ?? 1024,
    screenX: opts.screenX ?? 0,
    screenY: opts.screenY ?? 0,
    screen: { availLeft: 0, availTop: 0, availWidth: 3000, availHeight: 2000 },
    resizeTo,
    moveTo,
    history: { replaceState },
  });
  return { resizeTo, moveTo, replaceState };
}

afterEach(() => vi.unstubAllGlobals());

describe("applyWindowSizeHint", () => {
  it("resizes a standalone window to a valid hint, then strips the param", () => {
    const { resizeTo, replaceState } = stubWindow({ search: "?window-size=840x760" });
    applyWindowSizeHint();
    expect(resizeTo).toHaveBeenCalledWith(840, 760);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("preserves other query params while stripping window-size", () => {
    const { replaceState } = stubWindow({ search: "?foo=1&window-size=840x760" });
    applyWindowSizeHint();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?foo=1");
  });

  it("does not resize a non-standalone tab, but still strips the param", () => {
    const { resizeTo, replaceState } = stubWindow({
      search: "?window-size=840x760",
      standalone: false,
    });
    applyWindowSizeHint();
    expect(resizeTo).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("does not resize when the window already matches the hint", () => {
    const { resizeTo } = stubWindow({
      search: "?window-size=840x760",
      outerWidth: 840,
      outerHeight: 760,
    });
    applyWindowSizeHint();
    expect(resizeTo).not.toHaveBeenCalled();
  });

  it("ignores a garbage hint (no resize) but strips it", () => {
    const { resizeTo, replaceState } = stubWindow({ search: "?window-size=nope" });
    applyWindowSizeHint();
    expect(resizeTo).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("is a no-op with no hint param at all", () => {
    const { resizeTo, replaceState } = stubWindow({ search: "" });
    applyWindowSizeHint();
    expect(resizeTo).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("clamps a resized window back onto its own monitor", () => {
    // Parked near the right edge: after growing to 840 wide on a 3000px-wide work area, the
    // furthest-left it can sit is 3000-840=2160, so a window at x=2900 is pulled back to 2160.
    const { moveTo } = stubWindow({ search: "?window-size=840x760", screenX: 2900, screenY: 0 });
    applyWindowSizeHint();
    expect(moveTo).toHaveBeenCalledWith(2160, 0);
  });
});

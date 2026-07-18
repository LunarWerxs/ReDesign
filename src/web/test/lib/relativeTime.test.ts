import { describe, it, expect, vi } from "vitest";
import { formatAgo, formatAgoCoarse } from "@/lib/relativeTime";

const NOW = 1_700_000_000_000;
const ago = (ms: number) => NOW - ms;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAgo", () => {
  it("reports seconds under a minute", () => {
    expect(formatAgo(NOW, ago(0))).toBe("0s ago");
    expect(formatAgo(NOW, ago(12 * SEC))).toBe("12s ago");
    expect(formatAgo(NOW, ago(59 * SEC))).toBe("59s ago");
  });

  it("clamps a future timestamp to zero rather than emitting a negative", () => {
    expect(formatAgo(NOW, NOW + 5 * SEC)).toBe("0s ago");
  });

  it("rounds rather than floors at each bucket boundary", () => {
    // 90s is 1.5min, and the bucket rounds up. Flooring would say "1m ago".
    expect(formatAgo(NOW, ago(90 * SEC))).toBe("2m ago");
    // 90min is 1.5h, likewise.
    expect(formatAgo(NOW, ago(90 * MIN))).toBe("2h ago");
    // 36h is 1.5d, likewise.
    expect(formatAgo(NOW, ago(36 * HOUR))).toBe("2d ago");
  });

  it("promotes to the next unit exactly at the boundary", () => {
    expect(formatAgo(NOW, ago(MIN))).toBe("1m ago");
    expect(formatAgo(NOW, ago(HOUR))).toBe("1h ago");
    expect(formatAgo(NOW, ago(DAY))).toBe("1d ago");
  });

  it("keeps counting in days past a week", () => {
    expect(formatAgo(NOW, ago(9 * DAY))).toBe("9d ago");
  });

  it("delegates to the i18n translator with the bucketed count", () => {
    const t = vi.fn((key: string, params: { n: number }) => `${key}:${params.n}`);

    expect(formatAgo(NOW, ago(12 * SEC), t)).toBe("time.secondsAgo:12");
    expect(formatAgo(NOW, ago(5 * MIN), t)).toBe("time.minutesAgo:5");
    expect(formatAgo(NOW, ago(3 * HOUR), t)).toBe("time.hoursAgo:3");
    expect(formatAgo(NOW, ago(2 * DAY), t)).toBe("time.daysAgo:2");
  });
});

describe("formatAgoCoarse", () => {
  it("says 'just now' under ten seconds", () => {
    expect(formatAgoCoarse(NOW, ago(0))).toBe("just now");
    expect(formatAgoCoarse(NOW, ago(9 * SEC))).toBe("just now");
  });

  it("floors to ten-second steps for the rest of the first minute", () => {
    expect(formatAgoCoarse(NOW, ago(10 * SEC))).toBe("10s ago");
    // Floors here, unlike formatAgo's rounding: 47s reports as 40s, not 50s.
    expect(formatAgoCoarse(NOW, ago(47 * SEC))).toBe("40s ago");
    expect(formatAgoCoarse(NOW, ago(59 * SEC))).toBe("50s ago");
  });

  it("hands off to formatAgo at a minute and beyond", () => {
    expect(formatAgoCoarse(NOW, ago(MIN))).toBe("1m ago");
    expect(formatAgoCoarse(NOW, ago(3 * HOUR))).toBe("3h ago");
  });

  it("passes the translator through to the delegated buckets", () => {
    const t = vi.fn((key: string, params: { n: number }) => `${key}:${params.n}`);

    expect(formatAgoCoarse(NOW, ago(5 * MIN), t)).toBe("time.minutesAgo:5");
    // Sub-minute labels are English-only by design, so the translator stays unused.
    expect(formatAgoCoarse(NOW, ago(2 * SEC), t)).toBe("just now");
    expect(t).toHaveBeenCalledTimes(1);
  });
});

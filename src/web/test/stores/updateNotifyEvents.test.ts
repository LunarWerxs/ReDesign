import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createUpdateNotifyEventsActions } from "@/stores/control/update-notify-events";
import type { UpdateApplyResult, UpdateStatus } from "@/types";

// createUpdateNotifyEventsActions() is the daemon-wide "update available" push (src/bus.ts's
// "update_available" -> GET /api/events). Tested directly (not through the Pinia control store)
// the same way @/stores/viewer.ts's per-run SSE handling is tested: stub global EventSource and
// feed it synthetic messages.

const { toastMock } = vi.hoisted(() => {
  // Object.assign keeps `fn`'s own Mock typing (mockClear/.mock.calls) while adding the two
  // sub-methods AutoUpdateSection.vue's own toast.success/.error calls also rely on.
  const toastMock = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { toastMock };
});
vi.mock("vue-sonner", () => ({ toast: toastMock }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function okStatus(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ok: true,
    service: "redesign",
    currentVersion: "0.1.0",
    currentCommit: "aaaa",
    remoteCommit: "bbbb",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: true,
    canApply: true,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
function applyResult(over: Partial<UpdateApplyResult> = {}): UpdateApplyResult {
  return { ok: true, message: "updated", restartRequired: true, status: okStatus(), output: [], ...over };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect", () => {
  it("opens exactly one EventSource against the daemon-wide events URL", () => {
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate: vi.fn() });
    connect();
    connect(); // idempotent — a second call must not open a second connection
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/events");
  });
});

describe("update_available handling", () => {
  it("announces a toast with an Update now action when canApply is true", () => {
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate: vi.fn() });
    connect();
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "update_available", from: "aaaa", to: "bbbb", canApply: true, reason: null });

    expect(toastMock).toHaveBeenCalledTimes(1);
    const [, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.id).toBe("update-available");
    expect(opts.duration).toBe(Infinity);
    expect(opts.action).toMatchObject({ label: expect.any(String) });
  });

  it("omits the action when canApply is false (nothing to install yet)", () => {
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate: vi.fn() });
    connect();
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "update_available", from: "aaaa", to: "bbbb", canApply: false, reason: "dirty tree" });

    const [, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.action).toBeUndefined();
    expect(opts.description).toBe("dirty tree");
  });

  it("ignores messages of a different type", () => {
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate: vi.fn() });
    connect();
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "something_else" });

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("clicking Update now calls the shared applyUpdate() and reports success", async () => {
    const applyUpdate = vi.fn().mockResolvedValue(applyResult({ restartRequired: true }));
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate });
    connect();
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "update_available", from: "aaaa", to: "bbbb", canApply: true, reason: null });
    const [, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>];
    const action = opts.action as { onClick: () => void };
    action.onClick();
    await Promise.resolve(); // flush the async applyUpdate() handler
    await Promise.resolve();

    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });

  it("clicking Update now reports failure without throwing", async () => {
    const applyUpdate = vi.fn().mockRejectedValue(new Error("network down"));
    const { connect } = createUpdateNotifyEventsActions({ applyUpdate });
    connect();
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "update_available", from: "aaaa", to: "bbbb", canApply: true, reason: null });
    const [, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>];
    const action = opts.action as { onClick: () => void };
    action.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});

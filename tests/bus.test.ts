import { test, expect } from "bun:test";
import { addListener, removeListener, broadcast, type BusListener } from "../src/bus";

// The daemon-wide pub/sub GET /api/events (routes/events.ts) and src/auto-update.ts's notify
// path share. Exercised directly rather than through HTTP: the SSE plumbing itself has no more
// coverage here than GET /api/runs/:id/events does elsewhere in this suite, and the logic worth
// asserting is the pub/sub contract, not Hono's streaming transport.

test("broadcast delivers a JSON payload with `type` merged alongside the data", () => {
  const received: string[] = [];
  const listener: BusListener = (payload) => received.push(payload);
  addListener(listener);
  try {
    broadcast("update_available", { canApply: true, reason: null });
  } finally {
    removeListener(listener);
  }
  expect(received).toHaveLength(1);
  expect(JSON.parse(received[0]!)).toEqual({ type: "update_available", canApply: true, reason: null });
});

test("broadcast with no data still carries the type", () => {
  const received: string[] = [];
  const listener: BusListener = (payload) => received.push(payload);
  addListener(listener);
  try {
    broadcast("ping");
  } finally {
    removeListener(listener);
  }
  expect(JSON.parse(received[0]!)).toEqual({ type: "ping" });
});

test("reaches every listener, not just the first", () => {
  const a: string[] = [];
  const b: string[] = [];
  const la: BusListener = (p) => a.push(p);
  const lb: BusListener = (p) => b.push(p);
  addListener(la);
  addListener(lb);
  try {
    broadcast("x");
  } finally {
    removeListener(la);
    removeListener(lb);
  }
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
});

test("removeListener stops delivery", () => {
  const received: string[] = [];
  const listener: BusListener = (payload) => received.push(payload);
  addListener(listener);
  removeListener(listener);
  broadcast("x");
  expect(received).toHaveLength(0);
});

test("a throwing listener doesn't stop delivery to the rest", () => {
  const received: string[] = [];
  const bad: BusListener = () => {
    throw new Error("boom");
  };
  const good: BusListener = (payload) => received.push(payload);
  addListener(bad);
  addListener(good);
  try {
    expect(() => broadcast("x")).not.toThrow();
  } finally {
    removeListener(bad);
    removeListener(good);
  }
  expect(received).toHaveLength(1);
});

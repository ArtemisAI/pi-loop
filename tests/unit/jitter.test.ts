import { describe, it, expect } from "vitest";
import { jitterFrac, recurringJitterMs, oneShotJitterMs } from "../../src/jitter.js";
import { DEFAULT_CONFIG, type LoopTask } from "../../src/types.js";

function makeTask(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: "aabbccdd",
    cron: "*/5 * * * *",
    prompt: "test",
    createdAt: Date.now(),
    recurring: true,
    durable: false,
    ...overrides,
  };
}

describe("jitterFrac", () => {
  it("returns a value in [0, 1)", () => {
    const frac = jitterFrac("aabbccdd");
    expect(frac).toBeGreaterThanOrEqual(0);
    expect(frac).toBeLessThan(1);
  });

  it("is deterministic for the same ID", () => {
    expect(jitterFrac("aabbccdd")).toBe(jitterFrac("aabbccdd"));
  });

  it("differs for different IDs", () => {
    expect(jitterFrac("aabbccdd")).not.toBe(jitterFrac("11223344"));
  });

  it("returns 0 for all-zeros", () => {
    expect(jitterFrac("00000000")).toBe(0);
  });

  it("approaches 1 for all-f's", () => {
    const frac = jitterFrac("ffffffff");
    expect(frac).toBeGreaterThan(0.99);
    expect(frac).toBeLessThan(1);
  });
});

describe("recurringJitterMs", () => {
  it("is proportional to gap and jitter fraction", () => {
    const task = makeTask({ id: "80000000" }); // frac ~0.5
    const gapMs = 5 * 60 * 1000; // 5 minutes
    const jitter = recurringJitterMs(task, gapMs, DEFAULT_CONFIG);
    // frac * 0.1 * 300000 ≈ 15000
    expect(jitter).toBeGreaterThan(0);
    expect(jitter).toBeLessThanOrEqual(DEFAULT_CONFIG.recurringJitterCapMs);
  });

  it("is capped at recurringJitterCapMs", () => {
    const task = makeTask({ id: "ffffffff" }); // frac ~1
    const gapMs = 24 * 60 * 60 * 1000; // 1 day
    const jitter = recurringJitterMs(task, gapMs, DEFAULT_CONFIG);
    expect(jitter).toBe(DEFAULT_CONFIG.recurringJitterCapMs);
  });

  it("returns 0 for id 00000000", () => {
    const task = makeTask({ id: "00000000" });
    const jitter = recurringJitterMs(task, 5 * 60 * 1000, DEFAULT_CONFIG);
    expect(jitter).toBe(0);
  });
});

describe("oneShotJitterMs", () => {
  it("only jitters on minute boundaries", () => {
    const createdAt = new Date("2026-04-15T10:00:00").getTime();
    const task = makeTask({ recurring: false, id: "80000000", createdAt });
    // :30 is on a 30-mod boundary
    const onBoundary = new Date("2026-04-15T10:30:00").getTime();
    const jitter = oneShotJitterMs(task, onBoundary, DEFAULT_CONFIG);
    expect(jitter).toBeGreaterThan(0);

    // :07 is not on a 30-mod boundary
    const offBoundary = new Date("2026-04-15T10:07:00").getTime();
    const noJitter = oneShotJitterMs(task, offBoundary, DEFAULT_CONFIG);
    expect(noJitter).toBe(0);
  });

  it("never fires before creation time", () => {
    const createdAt = new Date("2026-04-15T10:29:50").getTime();
    const task = makeTask({ recurring: false, id: "ffffffff", createdAt });
    const fireTime = new Date("2026-04-15T10:30:00").getTime();
    const jitter = oneShotJitterMs(task, fireTime, DEFAULT_CONFIG);
    // Max possible lead is fireTime - createdAt = 10s
    expect(fireTime - jitter).toBeGreaterThanOrEqual(createdAt);
  });
});

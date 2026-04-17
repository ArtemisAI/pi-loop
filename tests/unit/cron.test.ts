import { describe, it, expect } from "vitest";
import {
  parseCronExpression,
  computeNextCronRun,
  nextCronRunMs,
  cronToHuman,
  intervalToCron,
  cronGapMs,
} from "../../src/cron.js";

describe("parseCronExpression", () => {
  it("parses a simple every-5-minutes expression", () => {
    const parsed = parseCronExpression("*/5 * * * *");
    expect(parsed).not.toBeNull();
    expect(parsed!.minute.values).toContain(0);
    expect(parsed!.minute.values).toContain(5);
    expect(parsed!.minute.values).toContain(55);
    expect(parsed!.minute.values).not.toContain(3);
  });

  it("parses a specific time (14:30 daily)", () => {
    const parsed = parseCronExpression("30 14 * * *");
    expect(parsed).not.toBeNull();
    expect(parsed!.minute.values.size).toBe(1);
    expect(parsed!.minute.values).toContain(30);
    expect(parsed!.hour.values.size).toBe(1);
    expect(parsed!.hour.values).toContain(14);
  });

  it("parses ranges", () => {
    const parsed = parseCronExpression("0 9 * * 1-5");
    expect(parsed).not.toBeNull();
    expect(parsed!.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parsed!.dayOfWeek.values).not.toContain(0);
    expect(parsed!.dayOfWeek.values).not.toContain(6);
  });

  it("parses comma-separated values", () => {
    const parsed = parseCronExpression("0,15,30,45 * * * *");
    expect(parsed).not.toBeNull();
    expect(parsed!.minute.values).toEqual(new Set([0, 15, 30, 45]));
  });

  it("rejects invalid expressions", () => {
    expect(parseCronExpression("")).toBeNull();
    expect(parseCronExpression("* * *")).toBeNull();
    expect(parseCronExpression("60 * * * *")).toBeNull();
    expect(parseCronExpression("* 25 * * *")).toBeNull();
    expect(parseCronExpression("* * 0 * *")).toBeNull(); // day-of-month is 1-31
    expect(parseCronExpression("* * * 13 *")).toBeNull(); // month is 1-12
    expect(parseCronExpression("* * * * 7")).toBeNull(); // dow is 0-6
  });

  it("rejects malformed fields", () => {
    expect(parseCronExpression("abc * * * *")).toBeNull();
    expect(parseCronExpression("*/0 * * * *")).toBeNull(); // step 0
  });
});

describe("computeNextCronRun", () => {
  it("finds next run for every-5-minutes", () => {
    const parsed = parseCronExpression("*/5 * * * *")!;
    const from = new Date("2026-04-15T10:02:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(5);
    expect(next!.getHours()).toBe(10);
  });

  it("wraps to next hour", () => {
    const parsed = parseCronExpression("0 * * * *")!;
    const from = new Date("2026-04-15T10:30:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(11);
    expect(next!.getMinutes()).toBe(0);
  });

  it("wraps to next day", () => {
    const parsed = parseCronExpression("0 9 * * *")!;
    const from = new Date("2026-04-15T10:00:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(16);
    expect(next!.getHours()).toBe(9);
  });

  it("respects day-of-week", () => {
    const parsed = parseCronExpression("0 9 * * 1")!; // Monday
    // April 15, 2026 is a Wednesday
    const from = new Date("2026-04-15T10:00:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1); // Monday
    expect(next!.getDate()).toBe(20); // Next Monday
  });

  it("starts from next minute (never fires at 'from' time)", () => {
    const parsed = parseCronExpression("30 10 * * *")!;
    const from = new Date("2026-04-15T10:30:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).not.toBeNull();
    // Should be next day, not same minute
    expect(next!.getDate()).toBe(16);
  });

  it("returns null for impossible expressions within a year", () => {
    // Feb 31 doesn't exist
    const parsed = parseCronExpression("0 0 31 2 *")!;
    const from = new Date("2026-01-01T00:00:00");
    const next = computeNextCronRun(parsed, from);
    expect(next).toBeNull();
  });
});

describe("nextCronRunMs", () => {
  it("returns epoch ms for valid cron", () => {
    const now = new Date("2026-04-15T10:00:00").getTime();
    const next = nextCronRunMs("*/5 * * * *", now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
  });

  it("returns null for invalid cron", () => {
    expect(nextCronRunMs("bad", Date.now())).toBeNull();
  });
});

describe("cronToHuman", () => {
  it("every N minutes", () => {
    expect(cronToHuman("*/5 * * * *")).toBe("every 5 minutes");
    expect(cronToHuman("*/1 * * * *")).toBe("every minute");
  });

  it("every N hours", () => {
    expect(cronToHuman("0 */2 * * *")).toBe("every 2 hours");
    expect(cronToHuman("0 */1 * * *")).toBe("every hour");
  });

  it("daily at specific time", () => {
    expect(cronToHuman("30 14 * * *")).toBe("daily at 2:30 PM");
    expect(cronToHuman("0 0 * * *")).toBe("every day at midnight");
    expect(cronToHuman("0 12 * * *")).toBe("daily at 12:00 PM");
  });

  it("every N days", () => {
    expect(cronToHuman("0 0 */1 * *")).toBe("every day at midnight");
    expect(cronToHuman("0 0 */3 * *")).toBe("every 3 days at midnight");
  });

  it("returns raw cron for unrecognized patterns", () => {
    expect(cronToHuman("0 9 * * 1-5")).toBe("0 9 * * 1-5");
  });
});

describe("intervalToCron", () => {
  it("converts minutes", () => {
    expect(intervalToCron("5m")).toBe("*/5 * * * *");
    expect(intervalToCron("30m")).toBe("*/30 * * * *");
  });

  it("converts hours", () => {
    expect(intervalToCron("2h")).toBe("0 */2 * * *");
  });

  it("converts days", () => {
    expect(intervalToCron("1d")).toBe("0 0 */1 * *");
  });

  it("rounds seconds up to 1 minute minimum", () => {
    expect(intervalToCron("30s")).toBe("*/1 * * * *");
    expect(intervalToCron("90s")).toBe("*/2 * * * *");
  });

  it("rounds large minutes to hours", () => {
    expect(intervalToCron("120m")).toBe("0 */2 * * *");
  });

  it("rejects invalid intervals", () => {
    expect(intervalToCron("")).toBeNull();
    expect(intervalToCron("abc")).toBeNull();
    expect(intervalToCron("0m")).toBeNull();
    expect(intervalToCron("-5m")).toBeNull();
  });
});

describe("cronGapMs", () => {
  it("computes gap between consecutive fires", () => {
    const now = new Date("2026-04-15T10:00:00").getTime();
    const gap = cronGapMs("*/5 * * * *", now);
    expect(gap).toBe(5 * 60 * 1000);
  });

  it("computes hourly gap", () => {
    const now = new Date("2026-04-15T10:00:00").getTime();
    const gap = cronGapMs("0 * * * *", now);
    expect(gap).toBe(60 * 60 * 1000);
  });
});

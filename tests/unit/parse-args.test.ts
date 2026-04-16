import { describe, it, expect } from "vitest";
import { parseLoopArgs } from "../../src/parse-args.js";

describe("parseLoopArgs", () => {
  it("parses leading interval", () => {
    const result = parseLoopArgs("5m check the deploy");
    expect(result).toEqual({
      interval: "5m",
      prompt: "check the deploy",
    });
  });

  it("parses trailing 'every' clause", () => {
    const result = parseLoopArgs("check the deploy every 20m");
    expect(result).toEqual({
      interval: "20m",
      prompt: "check the deploy",
    });
  });

  it("handles long-form units in trailing clause", () => {
    expect(parseLoopArgs("run tests every 5 minutes")).toEqual({
      interval: "5m",
      prompt: "run tests",
    });
    expect(parseLoopArgs("check status every 2 hours")).toEqual({
      interval: "2h",
      prompt: "check status",
    });
    expect(parseLoopArgs("backup every 1 day")).toEqual({
      interval: "1d",
      prompt: "backup",
    });
  });

  it("defaults to 10m when no interval specified", () => {
    const result = parseLoopArgs("check the deploy");
    expect(result).toEqual({
      interval: "10m",
      prompt: "check the deploy",
    });
  });

  it("returns null for empty input", () => {
    expect(parseLoopArgs("")).toBeNull();
    expect(parseLoopArgs("   ")).toBeNull();
  });

  it("handles seconds and days in leading position", () => {
    expect(parseLoopArgs("30s ping server")).toEqual({
      interval: "30s",
      prompt: "ping server",
    });
    expect(parseLoopArgs("1d daily report")).toEqual({
      interval: "1d",
      prompt: "daily report",
    });
  });

  it("does not treat a lone interval token as valid (needs prompt)", () => {
    // A lone "5m" has no prompt — falls through to default rule
    const result = parseLoopArgs("5m");
    expect(result).toEqual({
      interval: "10m",
      prompt: "5m",
    });
  });
});

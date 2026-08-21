import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyFrequencyEdit,
  applyPromptEdit,
  formatDuration,
  LoopsDashboard,
  type LoopsUiDeps,
  parseFrequencyInput,
  taskNextFireMs,
} from "../../src/loops-ui.js";
import { addTask, clearAllTasks, getAllTasks, getTask } from "../../src/store.js";
import { DEFAULT_CONFIG, type LoopTask } from "../../src/types.js";

function makeTask(over: Partial<LoopTask> = {}): LoopTask {
  return {
    id: over.id ?? Math.random().toString(36).slice(2, 10),
    cron: over.cron ?? "*/5 * * * *",
    prompt: over.prompt ?? "check the deploy",
    createdAt: over.createdAt ?? Date.now(),
    recurring: over.recurring ?? true,
    durable: over.durable ?? false,
    ...over,
  };
}

// Minimal structural fakes for the TUI + Theme the component depends on.
const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const fakeTui = { requestRender() {} } as any;

function makeDeps(cwd: string): LoopsUiDeps {
  return {
    getConfig: () => DEFAULT_CONFIG,
    getCwd: () => cwd,
    refreshStatus: () => {},
    schedulerRunning: () => true,
  };
}

describe("formatDuration", () => {
  it("clamps non-positive to 'now'", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5000)).toBe("now");
  });
  it("shows seconds under a minute", () => {
    expect(formatDuration(30_000)).toBe("30s");
  });
  it("rounds minutes up", () => {
    expect(formatDuration(90_000)).toBe("2m");
    expect(formatDuration(5 * 60_000)).toBe("5m");
  });
  it("shows hours and days", () => {
    expect(formatDuration(2 * 3600_000 + 3 * 60_000)).toBe("2h 3m");
    expect(formatDuration(3 * 86_400_000 + 3600_000)).toBe("3d 1h");
  });
});

describe("taskNextFireMs", () => {
  it("prefers a future scheduler-set nextFireTime", () => {
    const now = 1_000_000;
    const t = makeTask({ nextFireTime: now + 60_000 });
    expect(taskNextFireMs(t, now)).toBe(now + 60_000);
  });
  it("recomputes from cron when nextFireTime is stale/absent", () => {
    const now = 1_000_000;
    const t = makeTask({ nextFireTime: now - 60_000, cron: "*/5 * * * *" });
    const next = taskNextFireMs(t, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(t.lastFiredAt ?? t.createdAt);
  });
});

describe("parseFrequencyInput", () => {
  it("accepts interval shorthand", () => {
    expect(parseFrequencyInput("5m")).toEqual({ cron: "*/5 * * * *" });
    expect(parseFrequencyInput("2h")).toEqual({ cron: "0 */2 * * *" });
  });
  it("accepts a raw 5-field cron", () => {
    expect(parseFrequencyInput("0 9 * * 1-5")).toEqual({ cron: "0 9 * * 1-5" });
  });
  it("rejects empty and garbage", () => {
    expect("error" in parseFrequencyInput("")).toBe(true);
    expect("error" in parseFrequencyInput("nonsense")).toBe(true);
    expect("error" in parseFrequencyInput("* * *")).toBe(true);
  });
});

describe("applyPromptEdit / applyFrequencyEdit", () => {
  it("updates prompt on valid input, rejects empty", () => {
    const t = makeTask({ prompt: "old" });
    const ok = applyPromptEdit(t, "  new prompt  ");
    expect(ok).toEqual({ ok: true, task: { ...t, prompt: "new prompt" } });
    expect(applyPromptEdit(t, "   ")).toEqual({ ok: false, error: "Prompt cannot be empty" });
  });
  it("updates cron on valid frequency, rejects invalid", () => {
    const t = makeTask({ cron: "*/5 * * * *" });
    expect(applyFrequencyEdit(t, "10m")).toEqual({ ok: true, task: { ...t, cron: "*/10 * * * *" } });
    expect((applyFrequencyEdit(t, "banana") as { ok: false }).ok).toBe(false);
  });
});

describe("LoopsDashboard component wiring", () => {
  let tmp: string;
  beforeEach(() => {
    clearAllTasks();
    tmp = mkdtempSync(join(tmpdir(), "pi-loop-ui-"));
  });

  it("cancels the selected loop via d then y", () => {
    addTask(makeTask({ id: "abc12345" }));
    const dash = new LoopsDashboard(fakeTui, fakeTheme, () => {}, makeDeps(tmp));
    dash.render(80);
    dash.handleInput("d"); // → confirm
    dash.handleInput("y"); // confirm cancel
    expect(getTask("abc12345")).toBeUndefined();
    expect(getAllTasks()).toHaveLength(0);
  });

  it("declines cancellation on n", () => {
    addTask(makeTask({ id: "keepme00" }));
    const dash = new LoopsDashboard(fakeTui, fakeTheme, () => {}, makeDeps(tmp));
    dash.render(80);
    dash.handleInput("d");
    dash.handleInput("n"); // back out
    expect(getTask("keepme00")).toBeDefined();
  });

  it("cancels all loops via x then y", () => {
    addTask(makeTask());
    addTask(makeTask());
    addTask(makeTask());
    const dash = new LoopsDashboard(fakeTui, fakeTheme, () => {}, makeDeps(tmp));
    dash.render(80);
    dash.handleInput("x");
    dash.handleInput("y");
    expect(getAllTasks()).toHaveLength(0);
  });

  it("edits the selected loop's prompt (e, type, enter)", () => {
    addTask(makeTask({ id: "edit1234", prompt: "check the deploy" }));
    const dash = new LoopsDashboard(fakeTui, fakeTheme, () => {}, makeDeps(tmp));
    dash.render(80);
    dash.handleInput("e"); // seeds buffer with current prompt
    for (const ch of " now") dash.handleInput(ch);
    dash.handleInput("\r"); // enter → commit
    expect(getTask("edit1234")?.prompt).toBe("check the deploy now");
  });

  it("closes via q without mutating", () => {
    addTask(makeTask({ id: "safe0000" }));
    let closed = false;
    const dash = new LoopsDashboard(fakeTui, fakeTheme, () => (closed = true), makeDeps(tmp));
    dash.render(80);
    dash.handleInput("q");
    expect(closed).toBe(true);
    expect(getTask("safe0000")).toBeDefined();
  });
});

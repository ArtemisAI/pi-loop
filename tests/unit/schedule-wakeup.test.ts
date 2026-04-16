import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearAllTasks, addTask, getTask, getAllTasks } from "../../src/store.js";
import { generateTaskId } from "../../src/store.js";
import { DEFAULT_CONFIG, type LoopTask } from "../../src/types.js";
import { LoopScheduler } from "../../src/scheduler.js";

function createMockPi() {
  return {
    sendUserMessage: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as any;
}

function createMockCtx(hasUI = true) {
  return {
    hasUI,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    cwd: "/tmp",
  } as any;
}

function makeWakeupTask(delaySeconds: number): LoopTask {
  const fireAt = Date.now() + delaySeconds * 1000;
  return {
    id: generateTaskId(),
    cron: `_wakeup_${fireAt}`,
    prompt: "<<autonomous-loop-dynamic>>",
    createdAt: Date.now(),
    nextFireTime: fireAt,
    recurring: false,
    durable: false,
    label: "wakeup: test",
  };
}

describe("ScheduleWakeup", () => {
  let pi: ReturnType<typeof createMockPi>;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    clearAllTasks();
    pi = createMockPi();
    ctx = createMockCtx();
  });

  describe("wakeup task detection in scheduler", () => {
    it("does not fire before wake-up time", () => {
      const task = makeWakeupTask(300); // 5 minutes from now
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      expect((scheduler as any).shouldFire(task, Date.now())).toBe(false);
    });

    it("fires when wake-up time has passed", () => {
      const task = makeWakeupTask(-10); // 10 seconds ago
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      expect((scheduler as any).shouldFire(task, Date.now())).toBe(true);
    });

    it("removes wakeup task after firing (one-shot)", () => {
      const task = makeWakeupTask(-10);
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      (scheduler as any).fire(task);

      expect(getTask(task.id)).toBeUndefined();
      expect(pi.sendUserMessage).toHaveBeenCalledWith("<<autonomous-loop-dynamic>>");
    });
  });

  describe("tool registration", () => {
    it("registers the schedule_wakeup tool", async () => {
      const { registerWakeupTool } = await import("../../src/schedule-wakeup.js");
      const mockPi = { registerTool: vi.fn() } as any;
      registerWakeupTool(mockPi, DEFAULT_CONFIG);
      expect(mockPi.registerTool).toHaveBeenCalledTimes(1);

      const call = mockPi.registerTool.mock.calls[0][0];
      expect(call.name).toBe("schedule_wakeup");
      expect(call.label).toBe("Schedule Wake-up");
    });

    it("creates a task with _wakeup_ prefixed cron", async () => {
      const { registerWakeupTool } = await import("../../src/schedule-wakeup.js");
      const mockPi = { registerTool: vi.fn() } as any;
      registerWakeupTool(mockPi, DEFAULT_CONFIG);

      const toolDef = mockPi.registerTool.mock.calls[0][0];
      const result = await toolDef.execute(
        "test-call-id",
        { delaySeconds: 120, reason: "check status", prompt: "test prompt" },
        undefined,
        undefined,
        createMockCtx(),
      );

      expect(result.content[0].text).toContain("Wake-up scheduled");
      expect(result.content[0].text).toContain("120s");

      // Verify task was stored
      const allTasks = getAllTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0].cron).toMatch(/^_wakeup_\d+$/);
      expect(allTasks[0].nextFireTime).toBeGreaterThan(Date.now());
    });

    it("clamps delay to [60, 3600]", async () => {
      const { registerWakeupTool } = await import("../../src/schedule-wakeup.js");
      const mockPi = { registerTool: vi.fn() } as any;
      registerWakeupTool(mockPi, DEFAULT_CONFIG);

      const toolDef = mockPi.registerTool.mock.calls[0][0];

      // Too low
      clearAllTasks();
      const low = await toolDef.execute(
        "id", { delaySeconds: 5, reason: "test", prompt: "x" }, undefined, undefined, createMockCtx(),
      );
      expect(low.content[0].text).toContain("Clamped from 5s");

      // Too high
      clearAllTasks();
      const high = await toolDef.execute(
        "id", { delaySeconds: 9999, reason: "test", prompt: "x" }, undefined, undefined, createMockCtx(),
      );
      expect(high.content[0].text).toContain("Clamped from 9999s");
    });
  });
});

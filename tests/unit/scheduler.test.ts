import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoopScheduler } from "../../src/scheduler.js";
import { clearAllTasks, addTask, removeTask, getTask, getAllTasks } from "../../src/store.js";
import { generateTaskId } from "../../src/store.js";
import { DEFAULT_CONFIG, type LoopTask } from "../../src/types.js";

function makeTask(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: generateTaskId(),
    cron: "*/5 * * * *",
    prompt: "test prompt",
    createdAt: Date.now(),
    recurring: true,
    durable: false,
    ...overrides,
  };
}

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

describe("LoopScheduler", () => {
  let pi: ReturnType<typeof createMockPi>;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    clearAllTasks();
    pi = createMockPi();
    ctx = createMockCtx();
  });

  describe("start/stop", () => {
    it("starts and stops cleanly", () => {
      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.start();
      scheduler.stop();
      // No error thrown = success
    });

    it("does not start twice", () => {
      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.start();
      scheduler.start(); // Should be a no-op
      scheduler.stop();
    });
  });

  describe("shouldFire — recurring tasks", () => {
    it("does not fire when before next fire time", () => {
      // Create a task anchored 1 minute ago with 5-minute interval
      // Next fire should be ~4 minutes from now
      const task = makeTask({
        cron: "*/5 * * * *",
        createdAt: Date.now() - 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);

      // Manually check — should not fire
      // Access private method via (scheduler as any)
      expect((scheduler as any).shouldFire(task, Date.now())).toBe(false);
    });

    it("fires when past next fire time", () => {
      // Use 1-minute interval, anchored 30 minutes ago — well past due
      // even with 50% jitter (max 30s delay on 1-min interval)
      const task = makeTask({
        cron: "*/1 * * * *",
        createdAt: Date.now() - 30 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);

      expect((scheduler as any).shouldFire(task, Date.now())).toBe(true);
    });

    it("fires when lastFiredAt is set and past due", () => {
      const task = makeTask({
        cron: "*/1 * * * *", // 1-minute interval — smaller jitter window
        createdAt: Date.now() - 30 * 60_000,
        lastFiredAt: Date.now() - 5 * 60_000, // Last fired 5 min ago — well past next 1-min fire
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);

      // With 1-min interval and 5 min since last fire, should be well past due
      // even with 50% jitter (max 30s delay)
      expect((scheduler as any).shouldFire(task, Date.now())).toBe(true);
    });
  });

  describe("shouldFire — one-shot tasks", () => {
    it("fires one-shot when past due", () => {
      // One-shot anchored 6 minutes ago
      const task = makeTask({
        cron: "*/5 * * * *",
        recurring: false,
        createdAt: Date.now() - 6 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);

      expect((scheduler as any).shouldFire(task, Date.now())).toBe(true);
    });

    it("does not fire one-shot before due time", () => {
      const task = makeTask({
        cron: "0 * * * *", // Every hour at :00 — reliably in the future
        recurring: false,
        createdAt: Date.now(),
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);

      expect((scheduler as any).shouldFire(task, Date.now())).toBe(false);
    });
  });

  describe("fire", () => {
    it("injects prompt via sendUserMessage", () => {
      const task = makeTask({
        cron: "*/5 * * * *",
        createdAt: Date.now() - 6 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      (scheduler as any).fire(task);

      expect(pi.sendUserMessage).toHaveBeenCalledWith("test prompt");
    });

    it("removes one-shot task after firing", () => {
      const task = makeTask({
        cron: "*/5 * * * *",
        recurring: false,
        createdAt: Date.now() - 6 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      (scheduler as any).fire(task);

      expect(getTask(task.id)).toBeUndefined();
    });

    it("keeps recurring task after firing and updates lastFiredAt", () => {
      const task = makeTask({
        cron: "*/5 * * * *",
        recurring: true,
        createdAt: Date.now() - 6 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      (scheduler as any).fire(task);

      const stored = getTask(task.id);
      expect(stored).toBeDefined();
      expect(stored!.lastFiredAt).toBeDefined();
    });
  });

  describe("idle gating", () => {
    it("queues fires when busy and drains when idle", () => {
      const task = makeTask({
        cron: "*/1 * * * *", // 1-min interval for reliable firing
        createdAt: Date.now() - 10 * 60_000, // Well past due
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      scheduler.start();

      // Simulate agent being busy
      scheduler.setBusy();

      // Manually trigger check (should queue, not fire)
      (scheduler as any).check();

      // sendUserMessage should NOT have been called yet
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      // Pending fires should contain the task
      expect((scheduler as any).pendingFires).toHaveLength(1);

      // Set idle — should drain
      scheduler.setIdle();

      // Now it should have fired
      expect(pi.sendUserMessage).toHaveBeenCalledWith("test prompt");

      scheduler.stop();
    });

    it("does not queue same task twice", () => {
      const task = makeTask({
        cron: "*/1 * * * *",
        createdAt: Date.now() - 10 * 60_000,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      scheduler.setBusy();

      // Check twice — should only queue once
      (scheduler as any).check();
      (scheduler as any).check();

      expect((scheduler as any).pendingFires).toHaveLength(1);
    });
  });

  describe("isAgedOut", () => {
    it("expires recurring tasks after max age", () => {
      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");

      const task = makeTask({
        recurring: true,
        createdAt: Date.now() - DEFAULT_CONFIG.recurringMaxAgeMs - 1,
      });

      expect((scheduler as any).isAgedOut(task)).toBe(true);
    });

    it("does not expire recurring tasks within window", () => {
      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");

      const task = makeTask({
        recurring: true,
        createdAt: Date.now(),
      });

      expect((scheduler as any).isAgedOut(task)).toBe(false);
    });

    it("removes expired recurring task on fire (final fire)", () => {
      const task = makeTask({
        cron: "*/5 * * * *",
        recurring: true,
        createdAt: Date.now() - DEFAULT_CONFIG.recurringMaxAgeMs - 1,
      });
      addTask(task);

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      (scheduler as any).fire(task);

      // Task should be removed after final fire
      expect(getTask(task.id)).toBeUndefined();

      // But it should have fired once
      expect(pi.sendUserMessage).toHaveBeenCalledWith("test prompt");
    });
  });

  describe("refreshStatus", () => {
    it("sets status when tasks exist", () => {
      addTask(makeTask());

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      scheduler.refreshStatus();

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-loop", "1 loop active");
    });

    it("clears status when no tasks", () => {
      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      scheduler.setContext(ctx);
      scheduler.refreshStatus();

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-loop", undefined);
    });

    it("does nothing without context", () => {
      addTask(makeTask());

      const scheduler = new LoopScheduler(pi, DEFAULT_CONFIG, "/tmp");
      // No setContext call
      scheduler.refreshStatus();

      // Should not throw
    });
  });
});

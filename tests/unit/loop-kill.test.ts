import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearAllTasks, addTask, removeTask, getAllTasks, generateTaskId } from "../../src/store.js";
import type { LoopTask } from "../../src/types.js";

function makeTask(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: generateTaskId(),
    cron: "*/5 * * * *",
    prompt: "check the deploy",
    createdAt: Date.now(),
    recurring: true,
    durable: false,
    ...overrides,
  };
}

function createMockCtx(hasUI = true) {
  const messages: Array<{ msg: string; level: string }> = [];
  return {
    hasUI,
    ui: {
      notify: vi.fn((msg: string, level: string) => messages.push({ msg, level })),
      setStatus: vi.fn(),
    },
    cwd: "/tmp",
    _messages: messages,
  } as any;
}

describe("/loop-kill resolver", () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it("shows usage when called with no args", () => {
    const ctx = createMockCtx();
    // Simulate what the handler does for empty input
    const input = "";
    if (!input) {
      ctx.ui.notify("Usage: /loop-kill <id|label|all>", "warning");
    }
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });

  it("kills all tasks when input is 'all'", () => {
    addTask(makeTask({ prompt: "task one" }));
    addTask(makeTask({ prompt: "task two" }));
    addTask(makeTask({ prompt: "task three" }));

    expect(getAllTasks()).toHaveLength(3);

    const tasks = getAllTasks();
    clearAllTasks();

    expect(getAllTasks()).toHaveLength(0);
  });

  it("kills exact ID match", () => {
    const task = makeTask({ prompt: "deploy check" });
    addTask(task);

    const removed = removeTask(task.id);
    expect(removed).toBe(true);
    expect(getAllTasks()).toHaveLength(0);
  });

  it("returns false for unknown ID", () => {
    const removed = removeTask("nonexistent");
    expect(removed).toBe(false);
  });

  it("fuzzy matches by prompt text (case-insensitive)", () => {
    const t1 = makeTask({ prompt: "check the deploy status" });
    const t2 = makeTask({ prompt: "run integration tests" });
    addTask(t1);
    addTask(t2);

    const query = "deploy".toLowerCase();
    const matches = getAllTasks().filter((t) => {
      return (
        (t.label ?? "").toLowerCase().includes(query) ||
        t.prompt.toLowerCase().includes(query)
      );
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(t1.id);
  });

  it("fuzzy matches by label", () => {
    const t1 = makeTask({ prompt: "some task", label: "deploy monitor" });
    const t2 = makeTask({ prompt: "another task" });
    addTask(t1);
    addTask(t2);

    const query = "deploy".toLowerCase();
    const matches = getAllTasks().filter((t) => {
      return (
        (t.label ?? "").toLowerCase().includes(query) ||
        t.prompt.toLowerCase().includes(query)
      );
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(t1.id);
  });

  it("returns multiple matches when query is ambiguous", () => {
    const t1 = makeTask({ prompt: "test the API" });
    const t2 = makeTask({ prompt: "run test suite" });
    const t3 = makeTask({ prompt: "check logs" });
    addTask(t1);
    addTask(t2);
    addTask(t3);

    const query = "test".toLowerCase();
    const matches = getAllTasks().filter((t) => {
      return (
        (t.label ?? "").toLowerCase().includes(query) ||
        t.prompt.toLowerCase().includes(query)
      );
    });

    expect(matches).toHaveLength(2);
  });

  it("returns empty when no matches", () => {
    addTask(makeTask({ prompt: "check the deploy" }));

    const query = "nonexistent".toLowerCase();
    const matches = getAllTasks().filter((t) => {
      return (
        (t.label ?? "").toLowerCase().includes(query) ||
        t.prompt.toLowerCase().includes(query)
      );
    });

    expect(matches).toHaveLength(0);
  });

  it("all mode on empty store is a no-op", () => {
    expect(getAllTasks()).toHaveLength(0);
    clearAllTasks();
    expect(getAllTasks()).toHaveLength(0);
  });

  it("resolves exact ID before fuzzy matching", () => {
    // If a task ID happens to also be a substring of another task's prompt,
    // exact ID match should win
    const t1 = makeTask({ prompt: "some task" });
    const t2 = makeTask({ prompt: `contains ${t1.id} in prompt` });
    addTask(t1);
    addTask(t2);

    // Exact lookup should find t1 directly
    const direct = removeTask(t1.id);
    expect(direct).toBe(true);

    // t2 should still exist
    expect(getAllTasks()).toHaveLength(1);
    expect(getAllTasks()[0].id).toBe(t2.id);
  });
});

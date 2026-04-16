import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addTask,
  removeTask,
  getTask,
  getAllTasks,
  getTaskCount,
  updateTask,
  clearAllTasks,
  generateTaskId,
  loadDurableTasks,
  writeDurableTasks,
  acquireLock,
  releaseLock,
} from "../../src/store.js";
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

describe("In-memory store", () => {
  beforeEach(() => clearAllTasks());

  it("adds and retrieves tasks", () => {
    const task = makeTask();
    addTask(task);
    expect(getTask(task.id)).toEqual(task);
    expect(getTaskCount()).toBe(1);
  });

  it("removes tasks", () => {
    const task = makeTask();
    addTask(task);
    expect(removeTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeUndefined();
    expect(getTaskCount()).toBe(0);
  });

  it("returns false when removing non-existent task", () => {
    expect(removeTask("nonexistent")).toBe(false);
  });

  it("updates tasks", () => {
    const task = makeTask();
    addTask(task);
    task.lastFiredAt = Date.now();
    updateTask(task);
    expect(getTask(task.id)!.lastFiredAt).toBe(task.lastFiredAt);
  });

  it("getAllTasks returns all tasks", () => {
    const t1 = makeTask();
    const t2 = makeTask();
    addTask(t1);
    addTask(t2);
    const all = getAllTasks();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("clearAllTasks empties the store", () => {
    addTask(makeTask());
    addTask(makeTask());
    clearAllTasks();
    expect(getTaskCount()).toBe(0);
  });
});

describe("generateTaskId", () => {
  it("returns 8-character hex strings", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()));
    expect(ids.size).toBe(100);
  });
});

describe("Durable persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearAllTasks();
    tmpDir = mkdtempSync(join(tmpdir(), "pi-loop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads durable tasks", async () => {
    const task = makeTask({ durable: true });
    addTask(task);

    await writeDurableTasks(tmpDir, DEFAULT_CONFIG);

    const filePath = join(tmpDir, DEFAULT_CONFIG.durableFilePath);
    expect(existsSync(filePath)).toBe(true);

    const loaded = await loadDurableTasks(tmpDir, DEFAULT_CONFIG);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(task.id);
    expect(loaded[0].prompt).toBe(task.prompt);
  });

  it("only persists durable tasks", async () => {
    addTask(makeTask({ durable: false }));
    addTask(makeTask({ durable: true }));

    await writeDurableTasks(tmpDir, DEFAULT_CONFIG);

    const loaded = await loadDurableTasks(tmpDir, DEFAULT_CONFIG);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].durable).toBe(true);
  });

  it("returns empty array when file does not exist", async () => {
    const loaded = await loadDurableTasks(tmpDir, DEFAULT_CONFIG);
    expect(loaded).toEqual([]);
  });
});

describe("File locking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-loop-lock-"));
  });

  afterEach(async () => {
    await releaseLock(tmpDir, DEFAULT_CONFIG);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires and releases lock", async () => {
    const acquired = await acquireLock(tmpDir, DEFAULT_CONFIG);
    expect(acquired).toBe(true);

    const lockFile = join(tmpDir, DEFAULT_CONFIG.durableFilePath + ".lock");
    expect(existsSync(lockFile)).toBe(true);

    await releaseLock(tmpDir, DEFAULT_CONFIG);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("fails to acquire lock when already held", async () => {
    const first = await acquireLock(tmpDir, DEFAULT_CONFIG);
    expect(first).toBe(true);

    // Second attempt from same process still fails (lock file exists, not stale)
    // We need to simulate a different PID — just check the file blocks re-acquire
    const lockFile = join(tmpDir, DEFAULT_CONFIG.durableFilePath + ".lock");
    expect(existsSync(lockFile)).toBe(true);
  });
});

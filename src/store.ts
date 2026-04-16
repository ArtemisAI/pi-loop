/**
 * LoopTask CRUD — in-memory Map + durable .pi-loop.json persistence.
 * Includes file-based O_EXCL locking for multi-instance safety.
 */

import { readFile, writeFile, open, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LoopConfig, LoopTask, DurableFile } from "./types.js";

// --- In-memory store ---

const tasks = new Map<string, LoopTask>();

export function generateTaskId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function addTask(task: LoopTask): void {
  tasks.set(task.id, task);
}

export function removeTask(id: string): boolean {
  return tasks.delete(id);
}

export function getTask(id: string): LoopTask | undefined {
  return tasks.get(id);
}

export function getAllTasks(): LoopTask[] {
  return Array.from(tasks.values());
}

export function getTaskCount(): number {
  return tasks.size;
}

export function updateTask(task: LoopTask): void {
  tasks.set(task.id, task);
}

export function clearAllTasks(): void {
  tasks.clear();
}

// --- Durable file persistence ---

function durablePath(cwd: string, config: LoopConfig): string {
  return join(cwd, config.durableFilePath);
}

function lockPath(cwd: string, config: LoopConfig): string {
  return durablePath(cwd, config) + ".lock";
}

export async function loadDurableTasks(
  cwd: string,
  config: LoopConfig,
): Promise<LoopTask[]> {
  try {
    const raw = await readFile(durablePath(cwd, config), "utf-8");
    const data: DurableFile = JSON.parse(raw);
    if (!Array.isArray(data.tasks)) return [];
    return data.tasks;
  } catch {
    return [];
  }
}

export async function writeDurableTasks(
  cwd: string,
  config: LoopConfig,
): Promise<void> {
  const durableTasks = getAllTasks().filter((t) => t.durable);
  const data: DurableFile = { tasks: durableTasks };
  await writeFile(durablePath(cwd, config), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// --- File lock for multi-instance safety ---

interface LockContent {
  pid: number;
  acquiredAt: number;
}

const STALE_LOCK_MS = 30_000;

export async function acquireLock(
  cwd: string,
  config: LoopConfig,
): Promise<boolean> {
  const path = lockPath(cwd, config);
  const content: LockContent = {
    pid: process.pid,
    acquiredAt: Date.now(),
  };

  try {
    const fd = await open(path, "wx");
    await fd.writeFile(JSON.stringify(content));
    await fd.close();
    return true;
  } catch (err: any) {
    if (err.code !== "EEXIST") return false;

    // Check for stale lock
    try {
      const raw = await readFile(path, "utf-8");
      const lock: LockContent = JSON.parse(raw);
      if (Date.now() - lock.acquiredAt > STALE_LOCK_MS) {
        // Stale lock — remove and retry
        await unlink(path);
        return acquireLock(cwd, config);
      }
    } catch {
      // Can't read lock file — someone else has it
    }

    return false;
  }
}

export async function releaseLock(
  cwd: string,
  config: LoopConfig,
): Promise<void> {
  try {
    const path = lockPath(cwd, config);
    const raw = await readFile(path, "utf-8");
    const lock: LockContent = JSON.parse(raw);
    // Only release if we own it
    if (lock.pid === process.pid) {
      await unlink(path);
    }
  } catch {
    // Lock file gone or can't read — fine
  }
}

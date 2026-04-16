/**
 * LoopTask CRUD — in-memory Map + durable .pi-loop.json persistence.
 * Includes file-based O_EXCL locking for multi-instance safety.
 */

import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LoopConfig, LoopTask, DurableFile } from "./types.js";
import { nextCronRunMs } from "./cron.js";

// --- Debug logging ---

const DEBUG = process.env.PI_LOOP_DEBUG === '1' || process.env.PI_LOOP_DEBUG === 'true';

function debug(...args: any[]): void {
  if (!DEBUG) return;
  console.debug('[pi-loop]', ...args);
}

function logError(...args: any[]): void {
  console.error('[pi-loop]', ...args);
}

// --- In-memory store ---

const tasks = new Map<string, LoopTask>();

export function generateTaskId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function addTask(task: LoopTask): boolean {
  if (tasks.has(task.id)) {
    // Guard against duplicate ID (MD-005)
    debug('addTask: task ID already exists:', task.id);
    return false;
  }
  tasks.set(task.id, task);
  debug('addTask: added task', task.id, 'recurring:', task.recurring, 'durable:', task.durable);
  return true;
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

// --- Load result with missed task detection ---

export interface LoadResult {
  tasks: LoopTask[];         // All loaded tasks
  missedOneshots: LoopTask[];  // One-shots that missed their fire time
}

export async function loadDurableTasks(
  cwd: string,
  config: LoopConfig,
): Promise<LoadResult> {
  const result: LoadResult = { tasks: [], missedOneshots: [] };
  
  try {
    const raw = await readFile(durablePath(cwd, config), "utf-8");
    const data: DurableFile = JSON.parse(raw);
    
    if (!Array.isArray(data.tasks)) {
      logError('loadDurableTasks: tasks is not an array in', durablePath(cwd, config));
      return result;
    }
    
    const now = Date.now();
    
    for (const task of data.tasks) {
      // Detect missed one-shots
      if (!task.recurring && task.nextFireTime && now > task.nextFireTime) {
        debug('loadDurableTasks: missed one-shot detected', task.id, 
              'scheduled for', new Date(task.nextFireTime).toISOString());
        result.missedOneshots.push(task);
        // Don't add to active tasks - it missed its window
      } else {
        result.tasks.push(task);
      }
    }
    
    debug('loadDurableTasks: loaded', result.tasks.length, 'tasks,', 
          result.missedOneshots.length, 'missed one-shots');
    
    return result;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File doesn't exist - expected for new projects
      debug('loadDurableTasks: no durable file (new project)');
      return result;
    }
    if (err instanceof SyntaxError) {
      // JSON parse error - file corruption
      logError('loadDurableTasks: failed to parse durable tasks file:', err.message);
      // Consider backing up corrupted file
      return result;
    }
    // Unexpected error
    logError('loadDurableTasks: failed to load durable tasks:', err);
    return result;
  }
}

export async function writeDurableTasks(
  cwd: string,
  config: LoopConfig,
): Promise<void> {
  try {
    const durableTasks = getAllTasks().filter((t) => t.durable);
    const data: DurableFile = { tasks: durableTasks };
    await writeFile(durablePath(cwd, config), JSON.stringify(data, null, 2) + "\n", "utf-8");
    debug('writeDurableTasks: persisted', durableTasks.length, 'tasks');
  } catch (err) {
    logError('writeDurableTasks: failed to persist durable tasks:', err);
    throw err;  // Re-throw - caller should handle
  }
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

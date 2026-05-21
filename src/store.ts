/**
 * LoopTask CRUD — in-memory Map + durable .pi-loop.json persistence.
 * Includes file-based O_EXCL locking for multi-instance safety.
 */

import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
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

function durablePath(cwd: string, config: LoopConfig, isGlobal: boolean = false): string {
  const base = isGlobal ? homedir() : cwd;
  return join(base, config.durableFilePath);
}

function lockPath(cwd: string, config: LoopConfig, isGlobal: boolean = false): string {
  return durablePath(cwd, config, isGlobal) + ".lock";
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
  const now = Date.now();

  // Load from both local (CWD) and global (~) paths
  // Skip global if it resolves to the same file as local (e.g. when cwd == homedir)
  const localPath = durablePath(cwd, config, false);
  const globalPath = durablePath(cwd, config, true);
  const loadingPaths = localPath === globalPath ? [false] : [false, true];

  for (const isGlobal of loadingPaths) {
    const path = durablePath(cwd, config, isGlobal);
    try {
      const raw = await readFile(path, "utf-8");
      const data: DurableFile = JSON.parse(raw);

      if (!Array.isArray(data.tasks)) {
        logError('loadDurableTasks: tasks is not an array in', path);
        continue;
      }

      for (const task of data.tasks) {
        task.global = isGlobal;  // Mark origin
        if (!task.recurring && task.nextFireTime && now > task.nextFireTime) {
          debug('loadDurableTasks: missed one-shot detected', task.id,
            'scheduled for', new Date(task.nextFireTime).toISOString());
          result.missedOneshots.push(task);
        } else {
          result.tasks.push(task);
        }
      }

      debug('loadDurableTasks: loaded', data.tasks.length, 'tasks from', isGlobal ? 'global' : 'local', 'path');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        debug('loadDurableTasks: no durable file at', path);
        continue;
      }
      if (err instanceof SyntaxError) {
        logError('loadDurableTasks: failed to parse durable tasks file:', path, err.message);
        continue;
      }
      logError('loadDurableTasks: failed to load', path, err);
    }
  }

  debug('loadDurableTasks: total', result.tasks.length, 'tasks,',
    result.missedOneshots.length, 'missed one-shots');

  return result;
}

export async function writeDurableTasks(
  cwd: string,
  config: LoopConfig,
): Promise<void> {
  const durableTasks = getAllTasks().filter((t) => t.durable);
  const localTasks = durableTasks.filter(t => !t.global);
  const globalTasks = durableTasks.filter(t => t.global);

  try {
    // Write local tasks to CWD-based file
    if (localTasks.length > 0) {
      await writeFile(durablePath(cwd, config, false), JSON.stringify({ tasks: localTasks }, null, 2) + "\n", "utf-8");
    } else {
      try { await unlink(durablePath(cwd, config, false)); } catch { /* ignore */ }
    }

    // Write global tasks to ~/.pi-loop.json
    if (globalTasks.length > 0) {
      await writeFile(durablePath(cwd, config, true), JSON.stringify({ tasks: globalTasks }, null, 2) + "\n", "utf-8");
    } else {
      try { await unlink(durablePath(cwd, config, true)); } catch { /* ignore */ }
    }

    debug('writeDurableTasks: persisted', localTasks.length, 'local tasks,', globalTasks.length, 'global tasks');
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

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(
  cwd: string,
  config: LoopConfig,
  isGlobal: boolean = false,
): Promise<boolean> {
  const path = lockPath(cwd, config, isGlobal);
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

    // Check if lock owner is still alive via PID
    try {
      const raw = await readFile(path, "utf-8");
      const lock: LockContent = JSON.parse(raw);
      if (!isPidAlive(lock.pid)) {
        // Owner PID is dead — stale lock from crashed session
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
  isGlobal: boolean = false,
): Promise<void> {
  try {
    const path = lockPath(cwd, config, isGlobal);
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

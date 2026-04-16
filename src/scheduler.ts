/**
 * Core scheduler engine.
 *
 * 1-second tick loop that checks all tasks, gates on agent idle state,
 * fires prompts via pi.sendUserMessage(), and handles auto-expiry.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { nextCronRunMs, cronGapMs } from "./cron.js";
import { recurringJitterMs, oneShotJitterMs } from "./jitter.js";
import {
  getAllTasks,
  getTask,
  updateTask,
  removeTask,
  writeDurableTasks,
} from "./store.js";
import type { LoopConfig, LoopTask } from "./types.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: any[]): void {
  if (!DEBUG) return;
  console.debug("[pi-loop:scheduler]", ...args);
}

export class LoopScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private isAgentBusy = false;
  private pendingFires: string[] = [];
  private pi: ExtensionAPI;
  private config: LoopConfig;
  private cwd: string;
  private ctx: ExtensionContext | null = null;

  constructor(pi: ExtensionAPI, config: LoopConfig, cwd: string) {
    this.pi = pi;
    this.config = config;
    this.cwd = cwd;
  }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  setBusy(): void {
    this.isAgentBusy = true;
  }

  setIdle(): void {
    this.isAgentBusy = false;
    this.drainPendingFires();
  }

  private check(): void {
    const now = Date.now();

    for (const task of getAllTasks()) {
      if (this.shouldFire(task, now)) {
        if (this.isAgentBusy) {
          // Queue for later, but only if not already queued
          if (!this.pendingFires.includes(task.id)) {
            this.pendingFires.push(task.id);
          }
        } else {
          this.fire(task);
        }
      }
    }
  }

  private shouldFire(task: LoopTask, now: number): boolean {
    // Compute the base next fire time
    const anchor = task.lastFiredAt ?? task.createdAt;
    const baseNext = nextCronRunMs(task.cron, anchor);
    if (baseNext === null) return false;

    let fireTime: number;

    if (task.recurring) {
      // Forward jitter for recurring tasks
      const gap = cronGapMs(task.cron, anchor);
      const jitter = gap ? recurringJitterMs(task, gap, this.config) : 0;
      fireTime = baseNext + jitter;
    } else {
      // Backward jitter for one-shots
      const jitter = oneShotJitterMs(task, baseNext, this.config);
      fireTime = baseNext - jitter;
    }

    return now >= fireTime;
  }

  private fire(task: LoopTask): void {
    debug("fire:", task.id, task.prompt.slice(0, 40));

    // Notify UI
    if (this.ctx?.hasUI) {
      const label = task.label || task.prompt.slice(0, 40);
      this.ctx.ui.notify(`Loop firing: ${label}`, "info");
    }

    // Inject prompt as user message
    this.pi.sendUserMessage(task.prompt);

    // Update fire time
    task.lastFiredAt = Date.now();

    if (task.recurring) {
      if (this.isAgedOut(task)) {
        // Final fire — remove the task
        debug("fire:", task.id, "aged out, removing after final fire");
        removeTask(task.id);
        if (this.ctx?.hasUI) {
          this.ctx.ui.notify(
            `Loop ${task.id} expired after 7 days`,
            "warning",
          );
        }
      } else {
        updateTask(task);
      }
    } else {
      // One-shot: remove after firing
      removeTask(task.id);
    }

    // Persist durable tasks
    if (task.durable) {
      writeDurableTasks(this.cwd, this.config).catch(() => {});
    }

    this.updateStatus();
  }

  private drainPendingFires(): void {
    const ids = this.pendingFires.splice(0);
    for (const id of ids) {
      const task = getTask(id);
      if (task) {
        this.fire(task);
      }
    }
  }

  private isAgedOut(task: LoopTask): boolean {
    if (this.config.recurringMaxAgeMs <= 0) return false;
    return Date.now() - task.createdAt >= this.config.recurringMaxAgeMs;
  }

  private updateStatus(): void {
    if (!this.ctx?.hasUI) return;
    const count = getAllTasks().length;
    if (count > 0) {
      this.ctx.ui.setStatus("pi-loop", `${count} loop${count === 1 ? "" : "s"} active`);
    } else {
      this.ctx.ui.setStatus("pi-loop", undefined);
    }
  }

  /** Refresh status bar (called externally after task changes) */
  refreshStatus(): void {
    this.updateStatus();
  }
}

/**
 * Deterministic jitter system.
 *
 * Ported from Claude Code's cron jitter design:
 * - Recurring tasks: forward delay (spread fires over a window)
 * - One-shot tasks: backward lead (fire slightly early to avoid pile-ups)
 */

import type { LoopConfig, LoopTask } from "./types.js";

/**
 * Deterministic fraction [0, 1) from task ID.
 * The ID is an 8-hex-char string; we parse it as a u32 and divide.
 */
export function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x100000000;
  return Number.isFinite(frac) ? frac : 0;
}

/**
 * Compute jitter delay for a recurring task (forward delay in ms).
 *
 * nextFire = baseFire + frac * jitterFrac * gap
 * Capped at recurringJitterCapMs.
 */
export function recurringJitterMs(
  task: LoopTask,
  gapMs: number,
  config: LoopConfig,
): number {
  const frac = jitterFrac(task.id);
  const raw = frac * config.recurringJitterFrac * gapMs;
  return Math.min(raw, config.recurringJitterCapMs);
}

/**
 * Compute jitter for a one-shot task.
 *
 * Only applies if fire minute is on a boundary (e.g. :00 or :30).
 * Returns a POSITIVE value representing the lead time to subtract from fireTime.
 * Never fires before task creation time.
 */
export function oneShotJitterMs(
  task: LoopTask,
  fireTimeMs: number,
  config: LoopConfig,
): number {
  const fireDate = new Date(fireTimeMs);
  const fireMinute = fireDate.getMinutes();

  // Only jitter fires on minute boundaries
  if (fireMinute % config.oneShotJitterMinuteMod !== 0) return 0;

  const frac = jitterFrac(task.id);
  const lead =
    config.oneShotJitterFloorMs +
    frac * (config.oneShotJitterMaxMs - config.oneShotJitterFloorMs);

  // Never fire before creation
  const earliest = task.createdAt;
  const jittered = fireTimeMs - lead;
  if (jittered < earliest) return fireTimeMs - earliest;

  return lead;
}

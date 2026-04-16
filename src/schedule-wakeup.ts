/**
 * ScheduleWakeup — dynamic self-pacing for /loop without an interval.
 *
 * Unlike cron-based scheduling (fixed interval), ScheduleWakeup lets the
 * model choose its own delay each turn. The model calls schedule_wakeup
 * to arm a single-shot timer; on fire, the sentinel prompt is resolved
 * back to the loop instructions, and the model decides whether to continue
 * (call schedule_wakeup again) or stop (omit the call).
 *
 * Ported from Claude Code's ScheduleWakeup tool (v2.1.111).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { addTask, removeTask, getAllTasks, getTaskCount, generateTaskId } from "./store.js";
import type { LoopConfig, LoopTask } from "./types.js";

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;

const WakeupSchema = Type.Object({
  delaySeconds: Type.Number({
    description:
      "Seconds from now to wake up. Clamped to [60, 3600]. " +
      "Recommended: 1200-1800 for idle ticks (avoids burning the 5-min prompt cache). " +
      "Use 60-270 only for active work where cache stays warm.",
  }),
  reason: Type.String({
    description: "One short sentence explaining the chosen delay. Shown to the user.",
  }),
  prompt: Type.String({
    description:
      "The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn " +
      "so the next firing re-enters the skill. For autonomous /loop (no user prompt), " +
      "pass the literal sentinel '<<autonomous-loop-dynamic>>' instead.",
  }),
});

type WakeupParams = Static<typeof WakeupSchema>;

export function registerWakeupTool(
  pi: ExtensionAPI,
  config: LoopConfig,
): void {
  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule Wake-up",
    description:
      "Schedule a single-shot timer to fire after a delay. " +
      "For dynamic self-pacing: the model chooses its own delay each turn (60-3600 seconds), " +
      "calls this tool to arm the timer, and on wake-up decides whether to continue or stop. " +
      "Unlike cron_create (fixed schedule), this gives the model full control over pacing.\n\n" +
      "Cache guidance: The prompt cache has a 5-minute TTL. Sleeping past 300s means the next " +
      "wake-up reads full context uncached — slower and more expensive. For idle ticks, " +
      "prefer 1200-1800 seconds (20-30 min): pay one cache miss rather than 12 per hour. " +
      "Avoid exactly 300s (worst of both).",
    parameters: WakeupSchema,
    promptSnippet: "schedule_wakeup — arm a single-shot timer for dynamic self-pacing",

    async execute(_toolCallId, params: WakeupParams, _signal, _onUpdate, _ctx) {
      const clamped = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, params.delaySeconds));
      const fireAt = Date.now() + clamped * 1000;

      // Store as a one-shot task with a special marker
      const task: LoopTask = {
        id: generateTaskId(),
        cron: `_wakeup_${fireAt}`,
        prompt: params.prompt,
        createdAt: Date.now(),
        nextFireTime: fireAt,
        recurring: false,
        durable: false,
        label: `wakeup: ${params.reason}`,
      };

      addTask(task);

      const fireDate = new Date(fireAt).toLocaleString();
      return {
        content: [{
          type: "text",
          text: [
            `Wake-up scheduled.`,
            `  ID: ${task.id}`,
            `  Fires at: ${fireDate} (in ${clamped}s)`,
            `  Reason: ${params.reason}`,
            clamped !== params.delaySeconds
              ? `  (Clamped from ${params.delaySeconds}s to [${MIN_DELAY_SECONDS}, ${MAX_DELAY_SECONDS}])`
              : "",
            `Cancel with: cron_delete { id: "${task.id}" } or /loop-kill ${task.id}`,
          ].filter(Boolean).join("\n"),
        }],
        details: undefined,
      };
    },
  });
}

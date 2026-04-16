/**
 * LLM-callable tools: cron_create, cron_delete, cron_list.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { parseCronExpression, nextCronRunMs, cronToHuman } from "../cron.js";
import {
  addTask,
  removeTask,
  getAllTasks,
  getTaskCount,
  generateTaskId,
  writeDurableTasks,
} from "../store.js";
import type { LoopConfig, LoopTask } from "../types.js";
import type { LoopScheduler } from "../scheduler.js";

type Result = AgentToolResult<undefined>;

function result(text: string): Result {
  return { content: [{ type: "text", text }], details: undefined };
}

export function registerCronTools(
  pi: ExtensionAPI,
  scheduler: LoopScheduler,
  config: LoopConfig,
  getCwd: () => string,
): void {
  // --- CronCreate ---
  pi.registerTool({
    name: "cron_create",
    label: "Create Scheduled Task",
    description:
      "Schedule a prompt to run at a future time, either recurring on a cron schedule or once at a specific time. " +
      "The cron field uses standard 5-field format (minute hour day-of-month month day-of-week) in local time. " +
      "Examples: '*/5 * * * *' = every 5 minutes, '0 */2 * * *' = every 2 hours, '30 14 * * *' = daily at 2:30 PM.",
    parameters: Type.Object({
      cron: Type.String({
        description: "5-field cron expression in local time (minute hour dom month dow)",
      }),
      prompt: Type.String({
        description: "Prompt to enqueue at fire time",
      }),
      recurring: Type.Boolean({
        default: true,
        description: "true = fire on every match; false = one-shot then delete",
      }),
      durable: Type.Boolean({
        default: false,
        description: "true = persist to .pi-loop.json across sessions; false = session-only",
      }),
    }),
    promptSnippet:
      "cron_create — schedule a prompt to run on a cron schedule (recurring or one-shot)",

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<Result> {
      const parsed = parseCronExpression(params.cron);
      if (!parsed) {
        return result(`Invalid cron expression: "${params.cron}". Use 5-field format: minute hour day-of-month month day-of-week`);
      }

      const nextRun = nextCronRunMs(params.cron, Date.now());
      if (nextRun === null) {
        return result(`Cron expression "${params.cron}" does not match any date in the next year.`);
      }

      if (getTaskCount() >= config.maxJobs) {
        return result(`Maximum of ${config.maxJobs} scheduled tasks reached. Delete some tasks first.`);
      }

      const task: LoopTask = {
        id: generateTaskId(),
        cron: params.cron,
        prompt: params.prompt,
        createdAt: Date.now(),
        nextFireTime: params.recurring ? undefined : nextCronRunMs(params.cron, Date.now()) ?? undefined,
        recurring: params.recurring,
        durable: params.durable,
      };

      addTask(task);

      if (task.durable) {
        await writeDurableTasks(getCwd(), config);
      }

      scheduler.refreshStatus();

      const human = cronToHuman(params.cron);
      const nextDate = new Date(nextRun).toLocaleString();
      const expiryNote = params.recurring
        ? ` Auto-expires after ${Math.round(config.recurringMaxAgeMs / (24 * 60 * 60 * 1000))} days.`
        : " One-shot: will be deleted after firing.";

      return result([
        `Scheduled task created.`,
        `  ID: ${task.id}`,
        `  Schedule: ${human} (${params.cron})`,
        `  Next fire: ${nextDate}`,
        `  Prompt: ${task.prompt}`,
        `  Recurring: ${params.recurring}`,
        `  Durable: ${params.durable}`,
        expiryNote,
        `Cancel with: cron_delete { id: "${task.id}" } or /loop-kill ${task.id}`,
      ].join("\n"));
    },
  });

  // --- CronDelete ---
  pi.registerTool({
    name: "cron_delete",
    label: "Cancel Scheduled Task",
    description: "Cancel a scheduled cron task by ID. Use cron_list to see active tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to cancel" }),
    }),
    promptSnippet: "cron_delete — cancel a scheduled task by ID",

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<Result> {
      const removed = removeTask(params.id);
      if (!removed) {
        return result(`No task found with ID "${params.id}".`);
      }

      await writeDurableTasks(getCwd(), config).catch(() => {});
      scheduler.refreshStatus();

      return result(`Task ${params.id} cancelled.`);
    },
  });

  // --- CronList ---
  pi.registerTool({
    name: "cron_list",
    label: "List Scheduled Tasks",
    description: "List all active scheduled cron tasks with their IDs, schedules, and next fire times.",
    parameters: Type.Object({}),
    promptSnippet: "cron_list — list all active scheduled tasks",

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<Result> {
      const tasks = getAllTasks();
      if (tasks.length === 0) {
        return result("No scheduled tasks.");
      }

      const now = Date.now();
      const lines = tasks.map((t) => {
        const human = cronToHuman(t.cron);
        const next = nextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt);
        const nextStr = next ? new Date(next).toLocaleString() : "unknown";
        const age = Math.round((now - t.createdAt) / (60 * 1000));
        const flags = [
          t.recurring ? "recurring" : "one-shot",
          t.durable ? "durable" : "session-only",
        ].join(", ");

        return [
          `[${t.id}] ${human} (${t.cron})`,
          `  Prompt: ${t.prompt}`,
          `  Next: ${nextStr} | Created: ${age}m ago | ${flags}`,
        ].join("\n");
      });

      return result(`${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`);
    },
  });
}

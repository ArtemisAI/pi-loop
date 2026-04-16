/**
 * pi-loop — recurring prompt execution and cron scheduling for pi-agent.
 *
 * Registers:
 * - /loop, /loop-list, /loop-kill commands
 * - cron_create, cron_delete, cron_list LLM-callable tools
 * - Scheduler engine with idle gating
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { intervalToCron, cronToHuman, nextCronRunMs } from "./cron.js";
import { parseLoopArgs } from "./parse-args.js";
import { LoopScheduler } from "./scheduler.js";
import {
  addTask,
  removeTask,
  getAllTasks,
  getTaskCount,
  generateTaskId,
  loadDurableTasks,
  writeDurableTasks,
  acquireLock,
  releaseLock,
} from "./store.js";
import { registerCronTools } from "./tools/cron-tools.js";
import { DEFAULT_CONFIG, type LoopTask } from "./types.js";

export default function piLoop(pi: ExtensionAPI): void {
  const config = { ...DEFAULT_CONFIG };
  let cwd = process.cwd();
  let scheduler: LoopScheduler | null = null;
  let hasLock = false;

  // --- Commands ---

  pi.registerCommand("loop", {
    description:
      "Run a prompt on a recurring interval (e.g. /loop 5m check the deploy). Defaults to 10m.",

    getArgumentCompletions(prefix: string) {
      const suggestions = ["5m ", "10m ", "15m ", "30m ", "1h ", "2h "];
      return suggestions
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s.trim() }));
    },

    async handler(args, ctx) {
      const parsed = parseLoopArgs(args);
      if (!parsed) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Usage: /loop [interval] <prompt>\n" +
            "Examples: /loop 5m check the deploy, /loop check tests every 15m",
            "warning",
          );
        }
        return;
      }

      const cron = intervalToCron(parsed.interval);
      if (!cron) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Invalid interval: "${parsed.interval}". Use format: 5s, 10m, 2h, 1d`,
            "error",
          );
        }
        return;
      }

      if (getTaskCount() >= config.maxJobs) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Maximum of ${config.maxJobs} loops reached. Use /loop-kill to remove some.`,
            "error",
          );
        }
        return;
      }

      const task: LoopTask = {
        id: generateTaskId(),
        cron,
        prompt: parsed.prompt,
        createdAt: Date.now(),
        recurring: true,
        durable: false,
      };

      addTask(task);
      scheduler?.refreshStatus();

      const human = cronToHuman(cron);
      const nextRun = nextCronRunMs(cron, Date.now());
      const nextStr = nextRun ? new Date(nextRun).toLocaleString() : "soon";
      const expiryDays = Math.round(config.recurringMaxAgeMs / (24 * 60 * 60 * 1000));

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Loop ${task.id} created: ${human}\n` +
          `Next fire: ${nextStr}\n` +
          `Auto-expires in ${expiryDays} days. Cancel: /loop-kill ${task.id}`,
          "info",
        );
      }

      // Immediately execute the prompt (don't wait for first cron fire)
      pi.sendUserMessage(parsed.prompt);
    },
  });

  pi.registerCommand("loop-list", {
    description: "List all active loop tasks",

    async handler(_args, ctx) {
      const tasks = getAllTasks();
      if (tasks.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("No active loops.", "info");
        }
        return;
      }

      const now = Date.now();
      const lines = tasks.map((t) => {
        const human = cronToHuman(t.cron);
        const next = nextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt);
        const nextStr = next ? new Date(next).toLocaleString() : "unknown";
        const flags = [
          t.recurring ? "recurring" : "one-shot",
          t.durable ? "durable" : "session",
        ].join(", ");
        return `  [${t.id}] ${human} — ${t.prompt.slice(0, 50)} (next: ${nextStr}, ${flags})`;
      });

      if (ctx.hasUI) {
        ctx.ui.notify(
          `${tasks.length} active loop${tasks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("loop-kill", {
    description: "Cancel a loop task by ID",

    getArgumentCompletions(prefix: string) {
      return getAllTasks()
        .filter((t) => t.id.startsWith(prefix))
        .map((t) => {
          const label = `${t.id} — ${cronToHuman(t.cron)}: ${t.prompt.slice(0, 30)}`;
          return { value: t.id, label };
        });
    },

    async handler(args, ctx) {
      const id = args.trim();
      if (!id) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /loop-kill <task-id>", "warning");
        }
        return;
      }

      const removed = removeTask(id);
      if (!removed) {
        if (ctx.hasUI) {
          ctx.ui.notify(`No loop found with ID "${id}".`, "error");
        }
        return;
      }

      // Persist if we had durable tasks
      writeDurableTasks(cwd, config).catch(() => {});
      scheduler?.refreshStatus();

      if (ctx.hasUI) {
        ctx.ui.notify(`Loop ${id} cancelled.`, "info");
      }
    },
  });

  // --- LLM-callable tools ---
  // Deferred to session_start so scheduler is initialized

  // --- Lifecycle events ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Initialize scheduler
    scheduler = new LoopScheduler(pi, config, cwd);
    scheduler.setContext(ctx);

    // Register LLM tools (needs scheduler reference)
    registerCronTools(pi, scheduler, config, () => cwd);

    // Load durable tasks
    hasLock = await acquireLock(cwd, config);
    if (hasLock) {
      const durableTasks = await loadDurableTasks(cwd, config);
      for (const task of durableTasks) {
        addTask(task);
      }
    }

    // Start the scheduler tick loop
    scheduler.start();
    scheduler.refreshStatus();

    if (ctx.hasUI) {
      const count = getTaskCount();
      if (count > 0) {
        ctx.ui.notify(`pi-loop: ${count} task${count === 1 ? "" : "s"} loaded`, "info");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    scheduler?.stop();
    if (hasLock) {
      await releaseLock(cwd, config);
    }
  });

  // --- Idle gate ---

  pi.on("agent_start", () => {
    scheduler?.setBusy();
  });

  pi.on("agent_end", () => {
    scheduler?.setIdle();
  });
}

/**
 * pi-loop — recurring prompt execution and cron scheduling for pi-agent.
 *
 * Registers:
 * - /loop, /loop-list, /loop-kill commands
 * - cron_create, cron_delete, cron_list LLM-callable tools
 * - Scheduler engine with idle gating
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  clearAllTasks,
} from "./store.js";
import { registerCronTools } from "./tools/cron-tools.js";
import { DEFAULT_CONFIG, type LoopConfig, type LoopTask } from "./types.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: any[]): void {
  if (!DEBUG) return;
  console.debug("[pi-loop]", ...args);
}

async function loadProjectConfig(cwd: string): Promise<LoopConfig> {
  const defaults = { ...DEFAULT_CONFIG };
  try {
    const raw = await readFile(join(cwd, ".pi-loop.config.json"), "utf-8");
    const overrides = JSON.parse(raw);
    debug("loadProjectConfig: loaded overrides from .pi-loop.config.json");
    return { ...defaults, ...overrides };
  } catch {
    return defaults;
  }
}

export default function piLoop(pi: ExtensionAPI): void {
  let config = { ...DEFAULT_CONFIG };
  let cwd = process.cwd();
  let scheduler: LoopScheduler | null = null;
  let hasLock = false;
  let sessionSnapshot: LoopTask[] = [];

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

    // Load project-level config
    config = await loadProjectConfig(cwd);
    debug("session_start: config loaded, cwd =", cwd);

    // Initialize scheduler
    scheduler = new LoopScheduler(pi, config, cwd);
    scheduler.setContext(ctx);

    // Register LLM tools (needs scheduler reference)
    registerCronTools(pi, scheduler, config, () => cwd);

    // Load durable tasks
    hasLock = await acquireLock(cwd, config);
    if (hasLock) {
      const result = await loadDurableTasks(cwd, config);
      
      // Add active tasks
      for (const task of result.tasks) {
        addTask(task);
      }
      
      // Handle missed one-shots: fire them immediately
      // This recovers one-shot tasks that were scheduled while the agent was offline
      if (result.missedOneshots.length > 0) {
        const now = Date.now();
        for (const missed of result.missedOneshots) {
          const scheduledTime = missed.nextFireTime 
            ? new Date(missed.nextFireTime).toLocaleString() 
            : 'unknown';
          console.warn(`[pi-loop] Missed one-shot ${missed.id} scheduled for ${scheduledTime}, firing now`);
          
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Missed one-shot task recovered:\n${missed.prompt.slice(0, 100)}\nScheduled: ${scheduledTime}`,
              "warning"
            );
          }
          
          // Fire immediately if agent is idle (will be idle after session_start)
          pi.sendUserMessage(missed.prompt);
        }
      }
    }

    // Watch durable file for external changes (MD-008)
    const durablePath = join(cwd, config.durableFilePath);
    watchFile(durablePath, { interval: 5000 }, () => {
      if (!hasLock) return;
      debug("fileWatcher: durable file changed, reloading");
      loadDurableTasks(cwd, config).then((result) => {
        const fileIds = new Set(result.tasks.map((t) => t.id));
        for (const existing of getAllTasks()) {
          if (existing.durable && !fileIds.has(existing.id)) {
            removeTask(existing.id);
          }
        }
        const currentIds = new Set(getAllTasks().map((t) => t.id));
        for (const task of result.tasks) {
          if (!currentIds.has(task.id)) {
            addTask(task);
          }
        }
        scheduler?.refreshStatus();
      }).catch(() => {});
    });

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
    const dp = join(cwd, config.durableFilePath);
    unwatchFile(dp);
    if (hasLock) {
      await releaseLock(cwd, config);
    }
  });

  // --- Session compaction: preserve session-only tasks (HI-002) ---

  pi.on("session_before_compact", () => {
    sessionSnapshot = getAllTasks().filter((t) => !t.durable);
    debug("session_before_compact: snapshot", sessionSnapshot.length, "session-only tasks");
  });

  pi.on("session_compact", () => {
    const currentIds = new Set(getAllTasks().map((t) => t.id));
    let restored = 0;
    for (const task of sessionSnapshot) {
      if (!currentIds.has(task.id)) {
        addTask(task);
        restored++;
      }
    }
    if (restored > 0) {
      debug("session_compact: restored", restored, "session-only tasks");
      scheduler?.refreshStatus();
    }
    sessionSnapshot = [];
  });

  // --- Idle gate ---

  pi.on("agent_start", () => {
    debug("agent_start: scheduler set busy");
    scheduler?.setBusy();
  });

  pi.on("agent_end", () => {
    debug("agent_end: scheduler set idle");
    scheduler?.setIdle();
  });
}

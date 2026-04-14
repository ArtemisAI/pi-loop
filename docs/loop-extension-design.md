# Pi-Loop Extension Design Specification

> Design for a `/loop` extension for the pi-coding-agent, inspired by Claude Code's `/loop` skill and CronCreate/CronDelete/CronList scheduling system.

---

## 1. Goals

Bring scheduled/recurring prompt execution to the pi-coding-agent:

- Periodic status checks ("check the deploy every 5m")
- Automated monitoring ("watch the test suite every 15m")
- Scheduled reminders ("remind me at 2:30pm to review PRs")
- Self-pacing loops ("keep iterating on the refactor")

This maps Claude Code's `/loop` skill + CronCreate/CronDelete/CronList tool system onto the pi-coding-agent's extension API.

---

## 2. Architecture

```
+-------------------------------------------------------------------+
|                              pi-loop                               |
|                                                                     |
|  +-------------+  +-----------------------------+  +-----------+   |
|  |   Command   |  |   Tools (LLM-callable)      |  | Scheduler |   |
|  |   /loop     |  |   CronCreate                |  | Engine     |   |
|  |   /loop-list|  |   CronDelete                |  | (1s tick)  |   |
|  |   /loop-kill|  |   CronList                  |  |            |   |
|  +-------------+  +-----------------------------+  +-----------+   |
|        |                        |                        |         |
|  +---------------------------------------------------------------+ |
|  |               Extension API Integration                      |  |
|  |                                                              |  |
|  |  pi.sendUserMessage()  -> inject prompt when task fires     |  |
|  |  pi.appendEntry()      -> persist loop state in session     |  |
|  |  pi.on("agent_start") -> track idle/busy state             |  |
|  |  pi.on("agent_end")   -> track idle/busy state             |  |
|  |  ctx.ui.notify()       -> fire notifications                |  |
|  |  ctx.ui.setStatus()    -> persistent status bar indicator   |  |
|  +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+
```

---

## 3. Module Structure

```
pi-loop/
  index.ts            # Extension entry point (factory function)
  cron.ts             # 5-field cron parser + next-run calculator
  scheduler.ts        # Core scheduler: timer loop, fire dispatch
  store.ts            # LoopTask CRUD: in-memory + durable file storage
  jitter.ts           # Deterministic jitter calculations
  types.ts            # LoopTask, config types
  parse-args.ts       # /loop argument parsing (interval + prompt)
```

---

## 4. Types

### LoopTask

```typescript
import { Static, Type } from "@sinclair/typebox";

const LoopTaskSchema = Type.Object({
  id: Type.String(),           // 8-hex-char UUID slice (also jitter seed)
  cron: Type.String(),         // 5-field cron expression (local time)
  prompt: Type.String(),       // Prompt to send when task fires
  createdAt: Type.Number(),    // Epoch ms (anchor for missed detection)
  lastFiredAt: Type.Optional(Type.Number()),  // Epoch ms of most recent fire
  recurring: Type.Boolean(),   // true = reschedule; false = one-shot
  durable: Type.Boolean(),     // true = persist to .pi-loop.json
  label: Type.Optional(Type.String()),  // Optional human-readable label
});

type LoopTask = Static<typeof LoopTaskSchema>;
```

### LoopConfig

```typescript
interface LoopConfig {
  maxJobs: number;                    // Default: 50
  recurringMaxAgeMs: number;          // Default: 7 * 24 * 60 * 60 * 1000 (7 days)
  recurringJitterFrac: number;        // Default: 0.1 (10% of interval)
  recurringJitterCapMs: number;       // Default: 15 * 60 * 1000 (15 min)
  oneShotJitterMaxMs: number;         // Default: 90 * 1000 (90 sec)
  oneShotJitterFloorMs: number;       // Default: 0
  oneShotJitterMinuteMod: number;     // Default: 30 (jitter :00 and :30)
  checkIntervalMs: number;            // Default: 1000 (1s)
  durableFilePath: string;            // Default: ".pi-loop.json"
}
```

---

## 5. Commands

### /loop [interval] <prompt>

User-facing command to schedule a recurring loop.

**Argument parsing** (same priority as Claude Code):

| Priority | Rule | Example |
|----------|------|---------|
| 1 | Leading interval token `^\d+[smhd]$` | `5m check the deploy` -> interval 5m, prompt "check the deploy" |
| 2 | Trailing "every" clause | `check the deploy every 20m` -> interval 20m, prompt "check the deploy" |
| 3 | Default | `check the deploy` -> interval 10m, prompt "check the deploy" |

**Behavior:**
1. Parse args into interval + prompt
2. Convert interval to cron expression
3. Store the task (session-only by default)
4. Immediately execute the prompt (don't wait for first cron fire)
5. Notify user: task ID, schedule, 7-day auto-expiry, cancel instructions

### /loop-list

List all active loop tasks with their IDs, schedules, and next fire times.

### /loop-kill <id>

Cancel a loop task by ID.

---

## 6. LLM Tools

These tools allow the agent itself to schedule loops programmatically (not just via user command).

### CronCreate Tool

```typescript
pi.registerTool({
  name: "cron_create",
  label: "Create Scheduled Task",
  description: "Schedule a prompt to run at a future time, either recurring on a cron schedule or once at a specific time.",
  parameters: Type.Object({
    cron: Type.String({ description: "5-field cron expression in local time" }),
    prompt: Type.String({ description: "Prompt to enqueue at fire time" }),
    recurring: Type.Boolean({ default: true, description: "true = recurring; false = one-shot" }),
    durable: Type.Boolean({ default: false, description: "true = persist to disk; false = session-only" }),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    // Validate, create, store, return task ID
  },
});
```

### CronDelete Tool

```typescript
pi.registerTool({
  name: "cron_delete",
  label: "Cancel Scheduled Task",
  description: "Cancel a scheduled cron task by ID.",
  parameters: Type.Object({
    id: Type.String({ description: "Task ID to cancel" }),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    // Remove from store, confirm deletion
  },
});
```

### CronList Tool

```typescript
pi.registerTool({
  name: "cron_list",
  label: "List Scheduled Tasks",
  description: "List all scheduled cron tasks.",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
    // Return formatted list of tasks
  },
});
```

---

## 7. Scheduler Engine

### Core Loop

```typescript
class LoopScheduler {
  private interval: NodeJS.Timeout | null = null;
  private isAgentBusy = false;
  private pendingFires: string[] = [];

  start(): void {
    this.interval = setInterval(() => this.check(), config.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private check(): void {
    const now = Date.now();
    for (const task of getAllTasks()) {
      const nextFire = computeNextFire(task, now);
      if (nextFire !== null && now >= nextFire) {
        if (this.isAgentBusy) {
          this.pendingFires.push(task.id);
        } else {
          this.fire(task);
        }
      }
    }
  }

  private fire(task: LoopTask): void {
    // 1. Inject prompt via pi.sendUserMessage()
    // 2. Update lastFiredAt
    // 3. If one-shot or aged-out: remove task
    // 4. If recurring: reschedule from now + jitter
    // 5. Notify UI
  }
}
```

### Idle Gate

Unlike Claude Code which uses a React hook (`isLoading()`), pi-loop tracks idle state via events:

```typescript
pi.on("agent_start", () => { scheduler.setBusy(); });
pi.on("agent_end", () => {
  scheduler.setIdle();
  scheduler.drainPendingFires();  // fire any tasks that queued while busy
});
```

This mirrors Claude Code's "jobs only fire while the REPL is idle" constraint.

### Fire Dispatch

When a task fires:

```typescript
private fire(task: LoopTask): void {
  // Notify user
  ctx.ui.notify(`Running loop: ${task.label || task.prompt.slice(0, 40)}`);

  // Inject prompt as if the user typed it
  pi.sendUserMessage(task.prompt);

  // Track fire time
  task.lastFiredAt = Date.now();
  if (task.recurring && !isAgedOut(task)) {
    updateTask(task);
  } else {
    removeTask(task.id);
  }

  // Persist durable tasks
  if (task.durable) {
    writeDurableTasks();
  }
}
```

Using `pi.sendUserMessage()` ensures the prompt goes through the full agent pipeline (tool calls, streaming, etc.) just like a normal user input.

---

## 8. State Storage

### Session-Only (default)

Tasks live in a JavaScript `Map<string, LoopTask>` in the extension's closure. They die when the agent process exits.

```typescript
const sessionTasks = new Map<string, LoopTask>();

function addSessionTask(task: LoopTask): void {
  sessionTasks.set(task.id, task);
}
```

### Durable (opt-in via `durable: true`)

Tasks persist to `.pi-loop.json` in the project root:

```json
{
  "tasks": [
    {
      "id": "a3f2b9c1",
      "cron": "*/5 * * * *",
      "prompt": "check the deploy",
      "createdAt": 1712923200000,
      "lastFiredAt": 1712923500000,
      "recurring": true,
      "durable": true
    }
  ]
}
```

On `session_start`, durable tasks are loaded from disk. Missed one-shots are surfaced for confirmation.

### Session Entry Persistence

Using `pi.appendEntry()` for branch-aware state:

```typescript
pi.appendEntry("loop-created", { id, cron, prompt, recurring });
// This survives session branching/forking/navigating
```

---

## 9. Jitter System

Directly ported from Claude Code's design:

### Deterministic Per-Task Seed

```typescript
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x100000000;
  return Number.isFinite(frac) ? frac : 0;
}
```

### Recurring: Forward Delay

```
nextFire = baseFire + jitterFrac(id) * jitterFrac * gapBetweenFires
// capped at recurringJitterCapMs
```

An hourly task with `jitterFrac = 0.1` spreads fires over [:00, :06).

### One-Shot: Backward Lead

```
if (fireMinute % oneShotJitterMinuteMod !== 0) return fireTime  // no jitter
lead = jitterFloor + jitterFrac(id) * (jitterMax - jitterFloor)
return max(fireTime - lead, createdAt)  // never fire before creation
```

A one-shot at 3:00 PM may fire at ~2:58:30 PM.

---

## 10. Auto-Expiry

Recurring tasks auto-expire after 7 days (configurable). When `now - task.createdAt >= recurringMaxAgeMs`, the task fires one final time and is deleted.

This bounds memory usage and prevents unbounded session growth, matching Claude Code's design rationale.

---

## 11. Multi-Instance Safety

For durable tasks, a file-based lock prevents multiple pi-coding-agent instances from double-firing:

```typescript
// .pi-loop.lock (O_EXCL, same as Claude Code's scheduled_tasks.lock)
const lockContent = JSON.stringify({
  pid: process.pid,
  acquiredAt: Date.now(),
});
```

Only the lock owner processes durable tasks. Non-owners re-probe every 5 seconds.

---

## 12. Claude Code Feature Mapping

| Claude Code Feature | Pi-Loop Equivalent | Notes |
|----------------------|-------------------|-------|
| `/loop` skill | `pi.registerCommand("loop", ...)` | Same argument parsing |
| `CronCreate` tool | `pi.registerTool("cron_create", ...)` | TypeBox instead of Zod |
| `CronDelete` tool | `pi.registerTool("cron_delete", ...)` | |
| `CronList` tool | `pi.registerTool("cron_list", ...)` | |
| `cronScheduler.ts` | `scheduler.ts` class | Uses Node.js timers instead of React hooks |
| `cronTasks.ts` CRUD | `store.ts` | In-memory Map + `.pi-loop.json` |
| `cronTasksLock.ts` | In `store.ts` | O_EXCL lock file |
| `cron.ts` parser | `cron.ts` | Direct port |
| `cronJitterConfig.ts` | `jitter.ts` + config defaults | No GrowthBook; uses hardcoded defaults |
| `useScheduledTasks.ts` hook | `pi.on()` events | `agent_start`/`agent_end` for idle tracking |
| `enqueuePendingNotification()` | `pi.sendUserMessage()` | Same effect: injects prompt into agent |
| `isKairosCronEnabled()` gate | Always enabled | No feature flag needed for extension |
| `.claude/scheduled_tasks.json` | `.pi-loop.json` | Same format, different location |
| `.claude/scheduled_tasks.lock` | `.pi-loop.lock` | Same O_EXCL mechanism |
| `WORKLOAD_CRON` attribution | N/A | No billing tier concept in pi |
| `isMeta: true` messages | N/A | No hidden message concept needed |

---

## 13. Implementation Priority

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Core: `/loop` command + cron parser + in-memory scheduler + `pi.sendUserMessage()` | Design complete |
| 2 | Tools: `cron_create`, `cron_delete`, `cron_list` as LLM-callable tools | Design complete |
| 3 | Durable: `.pi-loop.json` persistence + file lock + missed task recovery | Design complete |
| 4 | Polish: jitter, auto-expiry, status bar widget, fire notifications | Design complete |
| 5 | Advanced: multi-session lock recovery, config file, npm package | Future |

---

## 14. Key Design Decisions

1. **Use `pi.sendUserMessage()` not `pi.sendMessage()`**: Loops should trigger full agent turns (tool calls, streaming), not just custom messages. `sendUserMessage` is the right injection point.

2. **No ScheduleWakeup equivalent**: Claude Code has a separate "dynamic mode" where the model self-paces. In pi-loop, all scheduling goes through cron. The model can use `cron_create` to set its own next fire time.

3. **No GrowthBook dependency**: Jitter config is hardcoded with sensible defaults. Future: allow `.pi-loop.config.json` for project-specific overrides.

4. **TypeBox over Zod**: Pi-coding-agent uses TypeBox for tool parameter schemas, so pi-loop follows the same convention.

5. **`.pi-loop.json` instead of `.claude/scheduled_tasks.json`**: Uses the pi naming convention and project root location instead of Claude Code's `.claude/` directory.

# Pi-Loop Extension Design Specification

> Design for a `/loop` extension for the pi-coding-agent, ported from Claude Code's `/loop` skill and CronCreate/CronDelete/CronList scheduling system.
>
> **Last updated**: 2026-04-16 — revised after deep-dive comparison against Claude Code source, pi-mono framework, and claw-code reference implementation.

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
|  |   /loop     |  |   cron_create               |  | Engine    |   |
|  |   /loop-list|  |   cron_delete               |  | (1s tick) |   |
|  |   /loop-kill|  |   cron_list                 |  |            |   |
|  +-------------+  +-----------------------------+  +-----------+   |
|        |                        |                        |         |
|  +---------------------------------------------------------------+ |
|  |               Extension API Integration                      |  |
|  |                                                              |  |
|  |  pi.sendUserMessage()  -> inject prompt when task fires     |  |
|  |  pi.on("session_start") -> restore durable tasks, init lock |  |
|  |  pi.on("session_shutdown") -> release lock, stop scheduler  |  |
|  |  pi.on("agent_start")  -> track idle/busy state            |  |
|  |  pi.on("agent_end")    -> track idle/busy state            |  |
|  |  ctx.ui.notify()       -> fire notifications                |  |
|  |  ctx.ui.setStatus()    -> persistent status bar indicator   |  |
|  +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+
```

### Framework Alignment

pi-loop is built on the pi-mono extension API (`@mariozechner/pi-coding-agent`):

| pi-mono API | pi-loop Usage |
|---|---|
| `pi.registerTool(ToolDefinition)` | cron_create, cron_delete, cron_list |
| `pi.registerCommand(name, options)` | /loop, /loop-list, /loop-kill |
| `pi.on("session_start", handler)` | Init scheduler, load durable tasks, acquire lock |
| `pi.on("session_shutdown", handler)` | Stop scheduler, release lock |
| `pi.on("agent_start" / "agent_end")` | Idle gating |
| `pi.sendUserMessage(content)` | Inject prompt when task fires |
| `ctx.ui.notify(message, type)` | User-visible notifications |
| `ctx.ui.setStatus(key, text)` | Status bar loop count |
| TypeBox (`@sinclair/typebox`) | Tool parameter schemas |

---

## 3. Module Structure

```
pi-loop/
  src/
    index.ts            # Extension entry point (factory function)
    cron.ts             # 5-field cron parser + next-run calculator
    scheduler.ts        # Core scheduler: timer loop, fire dispatch
    store.ts            # LoopTask CRUD: in-memory + durable file + lock
    jitter.ts           # Deterministic jitter calculations
    types.ts            # LoopTask, LoopConfig, DurableFile types
    parse-args.ts       # /loop argument parsing (interval + prompt)
    tools/
      cron-tools.ts     # cron_create, cron_delete, cron_list registration
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
  nextFireTime: Type.Optional(Type.Number()),  // Computed at creation for one-shots
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

### cron_create Tool

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

### cron_delete Tool

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

### cron_list Tool

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
  private interval: ReturnType<typeof setInterval> | null = null;
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
      if (this.shouldFire(task, now)) {
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
    // 6. Persist durable tasks
  }
}
```

### Idle Gate

```typescript
pi.on("agent_start", () => { scheduler.setBusy(); });
pi.on("agent_end", () => {
  scheduler.setIdle();
  scheduler.drainPendingFires();  // fire any tasks that queued while busy
});
```

This mirrors Claude Code's "jobs only fire while the REPL is idle" constraint. When the agent is busy (mid-turn), fires are queued in `pendingFires[]` and drained when the agent goes idle.

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

### Session-Only (default, `durable: false`)

Tasks live in a JavaScript `Map<string, LoopTask>` in the extension's closure. They die when the agent process exits.

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

On `session_start`, durable tasks are loaded from disk. Missed one-shots are detected and surfaced (see Issue CR-001 in ISSUES.md).

---

## 9. Jitter System

Ported from Claude Code's design. Prevents thundering-herd scenarios where many sessions hit the API at the same wall-clock time.

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

### One-Shot: Backward Lead

```
if (fireMinute % oneShotJitterMinuteMod !== 0) return 0  // no jitter
lead = oneShotFloor + jitterFrac(id) * (oneShotMax - oneShotFloor)
return max(fireTime - lead, createdAt)  // never fire before creation
```

### Jitter Defaults Comparison

| Parameter | Claude Code | pi-loop | Notes |
|---|---|---|---|
| `recurringFrac` | **0.5** (50%) | 0.1 (10%) | Claude Code spreads fires more aggressively |
| `recurringCapMs` | **1,800,000** (30 min) | 900,000 (15 min) | Claude Code allows wider spread window |
| `oneShotMaxMs` | 90,000 (90 sec) | 90,000 (90 sec) | Aligned |
| `oneShotFloorMs` | 0 | 0 | Aligned |
| `oneShotMinuteMod` | 30 | 30 | Aligned |
| `recurringMaxAgeMs` | 604,800,000 (7d) | 604,800,000 (7d) | Aligned |

**Note**: Claude Code's jitter is more aggressive (50% vs 10%, 30min cap vs 15min cap). This is a known gap — see ISSUES.md MD-007.

---

## 10. Auto-Expiry

Recurring tasks auto-expire after 7 days (configurable). When `now - task.createdAt >= recurringMaxAgeMs`, the task fires one final time and is deleted.

This bounds memory usage and prevents unbounded session growth, matching Claude Code's design rationale.

---

## 11. Multi-Instance Safety

For durable tasks, a file-based lock prevents multiple pi-coding-agent instances from double-firing:

```typescript
// .pi-loop.json.lock (O_EXCL)
const lockContent = JSON.stringify({
  pid: process.pid,
  acquiredAt: Date.now(),
});
```

### Known Issue (MD-006)

The current implementation uses a 30-second stale timeout (`STALE_LOCK_MS = 30_000`), which is too short for session-lifetime locks. The fix is to use PID-based liveness checking via `process.kill(pid, 0)` instead of timestamp-based staleness. See ISSUES.md and GitHub issue #1 for details.

### Claude Code's Approach

Claude Code uses the same O_EXCL pattern but with PID liveness checking:
- If the lock file exists and the owner PID is still alive -> wait
- If the owner PID is dead (crashed session) -> recover stale lock
- Non-owner sessions re-probe every 5 seconds

---

## 12. Claude Code Feature Mapping

| Claude Code Feature | Pi-Loop Equivalent | Status |
|---|---|---|
| `/loop` skill | `pi.registerCommand("loop", ...)` | Implemented - same argument parsing |
| `CronCreate` tool | `pi.registerTool("cron_create", ...)` | Implemented - TypeBox schemas |
| `CronDelete` tool | `pi.registerTool("cron_delete", ...)` | Implemented |
| `CronList` tool | `pi.registerTool("cron_list", ...)` | Implemented |
| 5-field cron parser | `src/cron.ts` | Implemented - direct port |
| Scheduler 1s tick loop | `src/scheduler.ts` | Implemented |
| Deterministic jitter | `src/jitter.ts` | Implemented - same algorithm |
| Idle gating | `agent_start`/`agent_end` events | Implemented |
| Pending fires + drain | `pendingFires[]` + `drainPendingFires()` | Implemented |
| Auto-expiry (7d) | `isAgedOut()` | Implemented |
| Durable persistence | `.pi-loop.json` | Implemented |
| O_EXCL file lock | `.pi-loop.json.lock` | Implemented (bug in stale detection) |
| `ScheduleWakeup` tool | -- | **Not implemented** |
| Dynamic self-pacing | -- | **Not implemented** |
| Missed one-shot detection | -- | **Not implemented** |
| Session resume reconstruction | -- | **Not implemented** |
| File watcher (chokidar) | -- | **Not implemented** |
| `Monitor` tool integration | -- | **Not implemented** |
| PID-based lock liveness | -- | **Not implemented** (uses timestamp) |
| Max 50 jobs limit | `config.maxJobs` | Implemented |
| Immediate first execution | `pi.sendUserMessage(parsed.prompt)` | Implemented |

---

## 13. Implementation Priority

| Phase | Scope | Status |
|---|---|---|
| 1 | Core: `/loop` command + cron parser + in-memory scheduler + `pi.sendUserMessage()` | Done |
| 2 | Tools: `cron_create`, `cron_delete`, `cron_list` as LLM-callable tools | Done |
| 3 | Durable: `.pi-loop.json` persistence + file lock | Done (lock has bug) |
| 4 | Polish: jitter, auto-expiry, status bar widget, fire notifications | Done |
| 5 | Fix lock: PID-based liveness check replacing 30s stale timeout | Pending (Issue #1) |
| 6 | Missed one-shot detection on startup | Planned (CR-001) |
| 7 | Session resume reconstruction after compaction | Planned |
| 8 | File watcher for durable task hot-reload | Planned |
| 9 | ScheduleWakeup / dynamic self-pacing mode | Planned |
| 10 | Bump jitter defaults to match Claude Code | Planned (MD-007) |

---

## 14. Key Design Decisions

1. **Use `pi.sendUserMessage()` not `pi.sendMessage()`**: Loops should trigger full agent turns (tool calls, streaming), not just custom messages. `sendUserMessage` is the right injection point.

2. **ScheduleWakeup deferred**: Claude Code has a separate "dynamic mode" where the model self-paces with `ScheduleWakeup`. In pi-loop, all scheduling currently goes through cron. The model can use `cron_create` to set its own next fire time. Dynamic pacing is planned for Phase 9.

3. **No GrowthBook dependency**: Jitter config is hardcoded with sensible defaults. Claude Code uses GrowthBook for fleet-wide runtime tuning, which isn't applicable to the pi ecosystem. Future: allow `.pi-loop.config.json` for project-specific overrides.

4. **TypeBox over Zod**: Pi-coding-agent uses TypeBox (`@sinclair/typebox`) for tool parameter schemas, so pi-loop follows the same convention. Claude Code uses Zod.

5. **`.pi-loop.json` instead of `.claude/scheduled_tasks.json`**: Uses the pi naming convention and project root location instead of Claude Code's `.claude/` directory.

6. **snake_case tool names**: Claude Code uses PascalCase (`CronCreate`, `CronDelete`, `CronList`). pi-loop uses snake_case (`cron_create`, `cron_delete`, `cron_list`) following pi-mono ecosystem conventions.

7. **`@mariozechner/pi-agent-core` import**: Tool results use `AgentToolResult` from `pi-agent-core`. Extensions should verify this dependency is available at runtime.

---

## 15. Reference Implementations

### Claude Code (TypeScript, closed source)
- Original implementation that pi-loop ports
- Tools: `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`
- Skills: `/loop` with 3-rule argument parsing
- Scheduler: 1s tick, chokidar file watcher, O_EXCL lock with PID liveness
- Jitter: Deterministic per-task, configurable via GrowthBook
- Storage: `.claude/scheduled_tasks.json` (durable), in-memory (session)

### claw-code (Rust, open source)
- Clean room re-implementation at `github.com/ultraworkers/claw-code`
- Has `CronCreate`/`CronDelete`/`CronList` as in-memory registry only
- **No real scheduler** — cron tools are data stores, no tick loop, no automatic execution
- No `/loop`, no `ScheduleWakeup`, no `Monitor`
- Unique features: worker boot state machine, lane events, recovery recipes

### pi-mono Framework (TypeScript, open source)
- The extension API pi-loop builds on
- Package: `@mariozechner/pi-coding-agent`
- **No built-in scheduling primitives** — extensions must implement their own
- Rich event system: `session_start`, `agent_start/end`, `tool_call/result`, etc.
- Tools defined via TypeBox schemas + `execute()` handlers

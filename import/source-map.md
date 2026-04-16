# Claude Code Source Map

> Structural analysis of the Claude Code source implementation that `/loop` and the scheduling system depend on.
>
> **Last updated**: 2026-04-16 — revised after deep-dive against Claude Code v2.1.111.

---

## Scheduling/Cron System (Core for pi-loop)

| Module | Path | Purpose |
|---|---|---|
| Loop Skill | `skills/bundled/loop.ts` | `/loop` command entry point, parses args, invokes CronCreate |
| CronCreate Tool | `tools/ScheduleCronTool/CronCreateTool.ts` | Creates cron jobs, validates, routes to session or disk |
| CronDelete Tool | `tools/ScheduleCronTool/CronDeleteTool.ts` | Cancels cron jobs by ID |
| CronList Tool | `tools/ScheduleCronTool/CronListTool.ts` | Lists all active cron jobs |
| Cron Prompt | `tools/ScheduleCronTool/prompt.ts` | System prompt builders, feature gates |
| Cron UI | `tools/ScheduleCronTool/UI.tsx` | React rendering for cron tool messages |
| Cron Engine | `utils/cron.ts` | 5-field cron parser, next-run calculator |
| Cron Task Store | `utils/cronTasks.ts` | CRUD operations, jitter logic, missed-task detection |
| Cron Scheduler | `utils/cronScheduler.ts` | 1s check loop, file watcher, lock coordination, fire routing |
| Cron Lock | `utils/cronTasksLock.ts` | O_EXCL lock with PID liveness checking |
| Cron Jitter Config | `utils/cronJitterConfig.ts` | GrowthBook-backed runtime jitter config |
| Scheduled Tasks Hook | `hooks/useScheduledTasks.ts` | React hook wiring scheduler into REPL |
| Bootstrap State | `bootstrap/state.ts` | Global state store, session cron tasks |
| ScheduleWakeup Tool | `tools/ScheduleWakeupTool.ts` | Dynamic self-pacing for /loop without interval |

### Data Flow

```
User types /loop 5m check the deploy
        |
        v
  loop.ts: buildPrompt(args)
        |  Generates model instructions
        v
  Model calls CronCreate tool
        |
        v
  CronCreateTool.call()
        |  Validates cron, creates CronTask
        |  Routes: durable? -> file : session
        v
  Scheduler starts (if not running)
        |
        v
  Every 1s: check()
        |  Compute nextFireAt + jitter
        |  If now >= nextFireAt and idle -> fire
        v
  Fire: pi.sendUserMessage(prompt)
        |  Injected as user input
        v
  Agent processes the prompt normally
```

### /loop Without Interval (Dynamic Mode)

```
User types /loop check deploy
        |
        v
  loop.ts: buildPrompt(args)
        |  No interval detected -> dynamic mode
        v
  Model executes the task immediately
        |
        v
  Model calls ScheduleWakeup({ delaySeconds: 1200 })
        |  Clamped to [60, 3600]
        v
  On wake-up: sentinel resolved to instructions
        |
        v
  Model decides: continue (call again) or stop (omit)
```

---

## Broader Source Structure

### Top-Level Directory Map

| Directory | Purpose |
|---|---|
| `assistant/` | Session history management |
| `bootstrap/` | App bootstrap + global state |
| `bridge/` | Remote/local bridge for IDE/browser |
| `cli/` | CLI/headless mode |
| `commands/` | 80+ slash command implementations |
| `components/` | 80+ React UI components |
| `context/` | React context providers |
| `coordinator/` | Multi-agent/swarm coordination |
| `entrypoints/` | App entry points: cli, init, mcp, sdk |
| `hooks/` | 80+ React hooks — interactive UI nerve center |
| `skills/` | Skill system: bundled implementations + directory loader |
| `tools/` | 30+ tool implementations |
| `utils/` | 250+ utility functions |
| `services/` | Core business logic (API, analytics, MCP, OAuth, etc.) |

### Skills System (`skills/`)

| File | Purpose |
|---|---|
| `bundled/loop.ts` | **`/loop` skill** |
| `bundled/scheduleRemoteAgents.ts` | Remote agent scheduling |
| `bundled/batch.ts` | Batch processing |
| `bundled/simplify.ts` | Code review |
| `bundled/updateConfig.ts` | Config updates |
| `bundled/remember.ts` | Memory/CLAUDE.md |

### Tools (`tools/`)

| Tool | Purpose |
|---|---|
| `ScheduleCronTool/` | Cron scheduling (CronCreate, CronDelete, CronList) |
| `ScheduleWakeupTool/` | Dynamic self-pacing (ScheduleWakeup) |
| `BashTool/` | Shell command execution |
| `AgentTool/` | Agent spawning |
| `FileReadTool/`, `FileEditTool/`, `FileWriteTool/` | File operations |
| `GlobTool/`, `GrepTool/` | Search |
| `MCPTool/` | MCP tool invocation |
| `TaskCreateTool/`, `TaskUpdateTool/` | Task list CRUD |
| `MonitorTool/` | Background process output streaming |
| `PushNotificationTool/` | Desktop/mobile push notifications |

### Hooks (`hooks/`)

| Hook | Purpose |
|---|---|
| `useScheduledTasks.ts` | Cron scheduler mounting & fire routing |
| `useMainLoopModel.ts` | Main conversation loop model |
| `useCommandQueue.ts` | Command queue processing |

---

## Reference Implementations Comparison

| Feature | Claude Code (TS) | claw-code (Rust) | pi-loop (TS) |
|---|---|---|---|
| CronCreate/Delete/List | Full | In-memory registry only | Full |
| Real scheduler | Yes (1s tick) | No | Yes (1s tick) |
| ScheduleWakeup | Yes | No | No |
| Monitor tool | Yes | No | No |
| PID-based lock | Yes | No | No (timestamp-based) |
| File watcher | Yes (chokidar) | No | No |
| Missed task detection | Yes | No | No |
| Session resume | Yes | No | No |
| Dynamic self-pacing | Yes | No | No |
| Deterministic jitter | Yes (50%/30min) | No | Yes (10%/15min) |
| Durable persistence | Yes | No | Yes |
| Multi-agent routing | Yes (teammates) | Yes (lanes) | No |
| Worker state machine | No | Yes | No |
| Recovery recipes | No | Yes (7 scenarios) | No |

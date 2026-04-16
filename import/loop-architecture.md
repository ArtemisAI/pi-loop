# /loop Architecture

> Deep analysis of how `/loop` works end-to-end in Claude Code. This documents the full pipeline from user invocation through scheduled task execution.
>
> **Last updated**: 2026-04-16 — revised after deep-dive against Claude Code v2.1.111 bundle analysis.

---

## 1. Skill Registration & Entry Point

The `/loop` skill is registered at app startup, gated by the `AGENT_TRIGGERS` feature flag.

| Property | Value |
|----------|-------|
| `name` | `"loop"` |
| `description` | `"Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)"` |
| `whenToUse` | "When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval" |
| `argumentHint` | `"[interval] <prompt>"` |
| `userInvocable` | `true` |
| `isEnabled` | `isKairosCronEnabled()` (runtime check) |

When the user types `/loop` with empty args, the skill returns `USAGE_MESSAGE`. Otherwise, it calls `buildPrompt(args)` which constructs a detailed instruction prompt for the model.

---

## 2. Argument Parsing Rules

The `buildPrompt()` function generates instructions for the model to parse the input. Parsing follows a **priority order**:

### Rule 1: Leading Interval Token
If the first whitespace-delimited token matches `^\d+[smhd]$`, that's the interval.

- `5m /babysit-prs` -> interval `5m`, prompt `/babysit-prs`
- `2h check the deploy` -> interval `2h`, prompt `check the deploy`

### Rule 2: Trailing "every" Clause
If the input ends with `every <N><unit>` or `every <N> <unit-word>`, extract as interval and strip from prompt.

- `check the deploy every 20m` -> interval `20m`, prompt `check the deploy`
- `run tests every 5 minutes` -> interval `5m`, prompt `run tests`
- `check every PR` -> does NOT match ("every PR" is not a time expression)

### Rule 3: Default
If no interval found, default to `10m`.

### Empty Prompt Handling
If parsing results in an empty prompt (e.g., just `5m` with nothing after), the model shows usage and stops.

---

## 3. Interval-to-Cron Conversion

| Interval Pattern | Cron Expression | Notes |
|---|---|---|
| `Ns` | Rounds up to `ceil(N/60)m` | Cron minimum is 1 minute |
| `Nm` where N <= 59 | `*/N * * * *` | Every N minutes |
| `Nm` where N >= 60 | `0 */H * * *` | Rounds to hours |
| `Nh` where N <= 23 | `0 */N * * *` | Every N hours |
| `Nh` where N > 23 | `0 0 */D * *` | Rounds to days |
| `Nd` | `0 0 */N * *` | Every N days at midnight local |

---

## 4. CronCreate Tool Flow

### Input Schema

| Field | Type | Default | Description |
|---|---|---|---|
| `cron` | string | required | 5-field cron expression in local time |
| `prompt` | string | required | Prompt to enqueue at fire time |
| `recurring` | boolean | `true` | `true` = fire on every match until expiry; `false` = one-shot then delete |
| `durable` | boolean | `false` | `true` = persist to `.claude/scheduled_tasks.json`; `false` = in-memory only |

### Validation
1. Cron expression must pass `parseCronExpression()` (valid 5-field syntax)
2. `nextCronRunMs(cron, Date.now())` must not be null (must match a date in the next year)
3. Total task count must be under `MAX_JOBS` (50)
4. Teammate crons cannot be `durable: true` (teammates don't survive across sessions)

### Tool Properties
- `shouldDefer: true` — runtime can defer execution
- Not `isConcurrencySafe` — creates new state
- Not `isReadOnly` — has side effects

### Execution Path

```
CronCreateTool.call({ cron, prompt, recurring, durable })
  |
  +-- effectiveDurable = durable && isDurableCronEnabled()
  |   (kill switch can force durable=false)
  |
  +-- id = addCronTask(cron, prompt, recurring, effectiveDurable, agentId?)
  |   |-- If !durable -> session store (STATE.sessionCronTasks)
  |   +-- If durable  -> file (.claude/scheduled_tasks.json)
  |
  +-- setScheduledTasksEnabled(true)
  |   (starts the scheduler if not already running)
  |
  +-- Return { id, humanSchedule, recurring, durable }
```

### Task ID
8-hex-char slices of UUID v4 (e.g., `"a3f2b9c1"`). Short because `MAX_JOBS = 50`. Also serves as the jitter seed (parsed as u32).

---

## 5. Storage: Session vs. Durable

### Session-Only (`durable: false`, default)
- Stored in-process: `STATE.sessionCronTasks`
- **Never written to disk**
- Dies when the process exits
- Reconstructed on session resume by scanning conversation history

### Durable (`durable: true`)
- Persisted to `<project>/.claude/scheduled_tasks.json`
- File format: `{ "tasks": [{ id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }] }`
- The `durable` flag is stripped by `writeCronTasks()` (on-disk tasks are implicitly durable)
- `agentId` is runtime-only (never persisted; teammate crons are always session-only)

---

## 6. Feature Gates

Three layers control `/loop` availability:

### Layer 1: Build-Time Gate
`feature('AGENT_TRIGGERS')` — eliminates cron code at compile time if unset.

### Layer 2: Environment Override
`CLAUDE_CODE_DISABLE_CRON=1` — immediately disables all cron functionality.

### Layer 3: GrowthBook Feature Flag
`tengu_kairos_cron` — fleet-wide kill switch with 5-minute cached refresh. Defaults to `true`.

Separate `isDurableCronEnabled()` on `tengu_kairos_cron_durable` (also defaults `true`).

---

## 7. Scheduler Engine

### Startup Flow

```
scheduler.start()
  |
  +-- Poll getScheduledTasksEnabled() every 1s until true
  |   (or auto-enable if scheduled_tasks.json has entries)
  |
  +-- Try acquire scheduler lock (O_EXCL)
  |   |-- Acquired -> isOwner = true -> process file-backed tasks
  |   +-- Failed -> stay passive, re-probe every 5s
  |
  +-- Watch .claude/scheduled_tasks.json with chokidar
  |   (awaitWriteFinish: { stabilityThreshold: 300 })
  |
  +-- Start 1-second setInterval(check)
```

### The check() Loop (Every 1 Second)

```
check()
  |
  +-- If isKilled() -> skip
  +-- If isLoading() -> skip (REPL busy, except assistant mode)
  |
  +-- Merge: fileTasks (if isOwner) + sessionTasks
  |
  +-- For each task:
  |   +-- Compute nextFireAt anchored from lastFiredAt ?? createdAt
  |   +-- Apply jitter:
  |   |   |-- Recurring: forward delay (frac * recurringFrac * gap)
  |   |   +-- One-shot: backward lead (only on boundary minutes)
  |   +-- If now >= nextFireAt:
  |   |   |-- Route: agentId? -> teammate : lead
  |   |   |-- Recurring + not aged: stamp lastFiredAt, reschedule
  |   |   |-- One-shot / aged recurring: delete task
  |   |   +-- Insert system message
  |   +-- Otherwise: skip
  |
  +-- After tick: batch-write lastFiredAt updates to disk
```

### Missed Task Handling (Startup Only)
When the scheduler loads file-backed tasks, it checks for one-shots whose `nextCronRunMs(cron, createdAt) < now`. These are surfaced for user confirmation (not auto-executed), then deleted from disk.

---

## 8. Fire Routing

When a task fires:

### Teammate Task
If `task.agentId` is set:
1. Look up teammate by `agentId`
2. If found and not terminal: `injectUserMessageToTeammate()`
3. If teammate gone: log warning, remove orphan task

### Lead Task
If no `agentId`:
1. Insert system message: `"Running scheduled task (Apr 13 2:30pm)"`
2. Enqueue via `enqueuePendingNotification()` with `priority: 'later'`, `isMeta: true`
3. REPL command queue drains between turns

### Idle Gate
Jobs only fire while the REPL is idle (`isLoading() === false`), except in assistant mode.

---

## 9. Jitter System

### Default Configuration (Claude Code Production)

| Parameter | Default | Effect |
|---|---|---|
| `recurringFrac` | **0.5** | Delay = 50% of interval |
| `recurringCapMs` | **1,800,000** (30 min) | Max forward delay |
| `oneShotMaxMs` | 90,000 (90 sec) | Max backward lead |
| `oneShotFloorMs` | 0 | Min backward lead |
| `oneShotMinuteMod` | 30 | Jitter :00 and :30 boundaries |
| `recurringMaxAgeMs` | 604,800,000 (7 days) | Auto-expiry |
| `cacheLeadMs` | 15,000 | Not used by pi-loop |

**Note**: These are the actual production values from Claude Code v2.1.111, not the GrowthBook defaults in the schema. The GrowthBook schema allows runtime tuning.

### Validation Bounds
```
recurringFrac: 0 to 1
recurringCapMs: 0 to 1,800,000 (30 min)
oneShotMaxMs: 0 to 1,800,000
oneShotFloorMs: 0 to 1,800,000
oneShotMinuteMod: 1 to 60
recurringMaxAgeMs: 0 to 2,592,000,000 (30 days)
```

### Deterministic Per-Task Seed
```typescript
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}
```

---

## 10. Auto-Expiry

Recurring tasks auto-expire after **7 days**. When `isRecurringTaskAged()` returns true, the task fires one final time and is deleted.

- `permanent: true` tasks never expire (assistant mode system tasks)
- `recurringMaxAgeMs: 0` means unlimited (never auto-expire)
- Max configurable: 30 days

---

## 11. Multi-Session Locking

### Mechanism
1. `tryAcquireSchedulerLock()` — O_EXCL atomic test-and-set on `.claude/scheduled_tasks.lock`
2. Lock file contains `{ sessionId, pid, acquiredAt }`
3. If lock held and PID alive -> another session owns it, wait
4. If PID dead -> stale lock from crashed session, recover
5. On session exit, `registerCleanup()` releases the lock

### Key Difference from pi-loop
Claude Code uses **PID liveness checking** (`process.kill(pid, 0)`) to determine if a lock is stale. pi-loop currently uses a 30-second timestamp-based timeout, which is the bug filed as Issue #1.

---

## 12. Immediate Execution

A critical design decision: `/loop 5m check the deploy` runs "check the deploy" **right now**, then schedules it to repeat every 5 minutes. This gives the user instant feedback rather than waiting for the first cron tick.

---

## 13. /loop vs ScheduleWakeup

These are **two separate systems**:

| Aspect | `/loop` (CronCreate) | ScheduleWakeup |
|---|---|---|
| Scheduler | Real 1s timer, file watcher, lock file | No scheduler (single-shot timer) |
| Persistence | Survives restarts (durable) or sessions | Dies with conversation |
| Self-pacing | Fixed interval via cron | Model chooses delay dynamically (60-3600s) |
| Continuation | Automatic (cron fires repeatedly) | Must call ScheduleWakeup again each turn |
| Use case | Scheduled/recurring tasks | Dynamic iteration within a session |
| Sentinel | `<<autonomous-loop>>` | `<<autonomous-loop-dynamic>>` |
| Granularity | Minute-level (cron) | Second-level (clamped [60, 3600]s) |
| Cache awareness | N/A | Explicit: 300s cache TTL consideration |

### ScheduleWakeup Constants
- `MIN_LOOP_DELAY_SECONDS = 60`
- `MAX_LOOP_DELAY_SECONDS = 3600`
- Default idle delay: 1200-1800 seconds (20-30 min)

When `/loop` is called **without an interval**, the model uses `ScheduleWakeup` to self-pace. With an explicit interval, it creates a proper CronCreate-backed cron job.

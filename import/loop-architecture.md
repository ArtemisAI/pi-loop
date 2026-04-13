# /loop Architecture

> Deep analysis of how `/loop` works end-to-end in Claude Code. This documents the full pipeline from user invocation through scheduled task execution.

---

## 1. Skill Registration & Entry Point

**File**: `skills/bundled/loop.ts`

The `/loop` skill is registered at app startup by `index.ts` calling `registerLoopSkill()`, but **only if** the `AGENT_TRIGGERS` feature flag is enabled. The registration is unconditional (the skill is always added to the registry), but `isKairosCronEnabled()` serves as the `isEnabled` callback — it controls runtime visibility, not whether the skill is registered.

```typescript
// In skills/bundled/index.ts
if (feature('AGENT_TRIGGERS')) {
  const { registerLoopSkill } = require('./loop.js')
  registerLoopSkill()
}
```

The skill definition:

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

- `5m /babysit-prs` → interval `5m`, prompt `/babysit-prs`
- `2h check the deploy` → interval `2h`, prompt `check the deploy`

### Rule 2: Trailing "every" Clause
If the input ends with `every <N><unit>` or `every <N> <unit-word>`, extract as interval and strip from prompt. Only matches when "every" is followed by a time expression.

- `check the deploy every 20m` → interval `20m`, prompt `check the deploy`
- `run tests every 5 minutes` → interval `5m`, prompt `run tests`
- `check every PR` → does NOT match ("every PR" is not a time expression)

### Rule 3: Default
If no interval found, default to `10m`.

- `check the deploy` → interval `10m`, prompt `check the deploy`

### Empty Prompt Handling
If parsing results in an empty prompt (e.g., just `5m` with nothing after), the model shows usage and stops — it does NOT call CronCreate.

---

## 3. Interval-to-Cron Conversion

| Interval Pattern | Cron Expression | Notes |
|-----------------|-----------------|-------|
| `Nm` where N ≤ 59 | `*/N * * * *` | Every N minutes |
| `Nm` where N ≥ 60 | `0 */H * * *` | Round to hours (H = N/60, must divide 24) |
| `Nh` where N ≤ 23 | `0 */N * * *` | Every N hours |
| `Nd` | `0 0 */N * *` | Every N days at midnight local |
| `Ns` | `ceil(N/60)m` → same as minutes | Cron minimum granularity is 1 minute |

### Uneven Interval Handling
If the interval doesn't cleanly divide its unit (e.g., `7m` gives uneven gaps at :56→:00; `90m` = 1.5h which cron can't express), the model must pick the nearest clean interval and tell the user what it rounded to before scheduling.

---

## 4. CronCreate Tool Flow

**File**: `tools/ScheduleCronTool/CronCreateTool.ts`

### Input Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cron` | string | required | 5-field cron expression in local time |
| `prompt` | string | required | Prompt to enqueue at fire time |
| `recurring` | boolean | `true` | `true` = fire on every match until expiry; `false` = one-shot then delete |
| `durable` | boolean | `false` | `true` = persist to `.claude/scheduled_tasks.json`; `false` = in-memory only |

### Validation
1. Cron expression must pass `parseCronExpression()` (valid 5-field syntax)
2. `nextCronRunMs(cron, Date.now())` must not be null (must match a date in the next year)
3. Total task count must be under `MAX_JOBS` (50)
4. Teammate crons cannot be `durable: true` (teammates don't survive across sessions)

### Execution Path

```
CronCreateTool.call({ cron, prompt, recurring, durable })
  │
  ├─ effectiveDurable = durable && isDurableCronEnabled()
  │   (kill switch can force durable=false even if model requested true)
  │
  ├─ id = addCronTask(cron, prompt, recurring, effectiveDurable, agentId?)
  │   │
  │   ├─ If !durable → addSessionCronTask() → STATE.sessionCronTasks
  │   └─ If durable  → readCronTasks() + writeCronTasks() → .claude/scheduled_tasks.json
  │
  ├─ setScheduledTasksEnabled(true)
  │   (starts the scheduler if not already running)
  │
  └─ Return { id, humanSchedule: cronToHuman(cron), recurring, durable }
```

### Task ID
IDs are 8-hex-char slices of UUID v4 (e.g., `"a3f2b9c1"`). Short because `MAX_JOBS = 50`, so collision risk is negligible. The ID also serves as the jitter seed (parsed as u32 for deterministic per-task delay).

---

## 5. Storage: Session vs. Durable

### Session-Only (`durable: false`, default)
- Stored in-process: `STATE.sessionCronTasks` (array in `bootstrap/state.ts`)
- Added via `addSessionCronTask()`, removed via `removeSessionCronTasks()`
- **Never written to disk**
- Dies when the process exits
- Scheduler reads fresh from `getSessionCronTasks()` on every 1-second tick

### Durable (`durable: true`)
- Persisted to `<project>/.claude/scheduled_tasks.json`
- File format: `{ "tasks": [{ id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }] }`
- The `durable` flag is stripped by `writeCronTasks()` (on-disk tasks are implicitly durable)
- `agentId` is runtime-only (never persisted; teammate crons are always session-only)

### Kill Switch
`CronCreateTool.call()` forces `durable = false` if `isDurableCronEnabled()` returns false, regardless of model request. The schema stays stable so the model sees no validation errors when the gate flips mid-session.

---

## 6. Feature Gates

Three layers control `/loop` availability:

### Layer 1: Build-Time Gate
`feature('AGENT_TRIGGERS')` — a Bun bundle feature flag. If the build omits `AGENT_TRIGGERS`, the entire cron system is eliminated at compile time (dead code elimination). The `/loop` skill, cron tools, and scheduler are all gated on this.

### Layer 2: Environment Override
`CLAUDE_CODE_DISABLE_CRON=1` — immediately disables all cron functionality, winning over GrowthBook. Set this env var to kill the scheduler.

### Layer 3: GrowthBook Feature Flag
`tengu_kairos_cron` — a fleet-wide kill switch with 5-minute cached refresh. Defaults to `true` (so Bedrock/Vertex/Foundry and `DISABLE_TELEMETRY` users get /loop). When flipped to `false`, already-running schedulers stop on their next `isKilled()` poll tick.

There's also a separate `isDurableCronEnabled()` check on `tengu_kairos_cron_durable` (also defaults to `true`) — this controls only the durable sub-feature, not the entire scheduling system.

```typescript
function isKairosCronEnabled(): boolean {
  return feature('AGENT_TRIGGERS')
    ? !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON) &&
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_cron',
          true,
          5 * 60 * 1000,
        )
    : false
}
```

---

## 7. Scheduler Engine

**File**: `utils/cronScheduler.ts`

### Startup Flow

```
scheduler.start()
  │
  ├─ If !assistantMode: poll getScheduledTasksEnabled() every 1s until true
  │   (flag set by CronCreate or auto-enabled if scheduled_tasks.json has entries)
  │
  ├─ If assistantMode: auto-enable immediately (don't wait for skill to flip flag)
  │
  ├─ Try acquire scheduler lock (O_EXCL on .claude/scheduled_tasks.lock)
  │   ├─ Acquired → isOwner = true → process file-backed tasks
  │   └─ Failed → stay passive, re-probe lock every 5s
  │
  ├─ Watch .claude/scheduled_tasks.json with chokidar
  │   (awaitWriteFinish: { stabilityThreshold: 300 })
  │
  └─ Start 1-second setInterval(check)
```

### The check() Loop (Every 1 Second)

```
check()
  │
  ├─ If isKilled() → skip (GrowthBook kill switch)
  ├─ If isLoading() && !assistantMode → skip (REPL busy)
  │
  ├─ Merge: fileTasks (if isOwner) + sessionTasks
  │
  ├─ For each task:
  │   ├─ If first seen: compute nextFireAt anchored from lastFiredAt ?? createdAt
  │   │   (never-fired tasks use createdAt so pinned crons don't skip)
  │   ├─ If now >= nextFireAt:
  │   │   ├─ Route: agentId? → teammate queue
  │   │   │          otherwise → lead queue ('later' priority)
  │   │   ├─ Recurring + not aged: stamp lastFiredAt, reschedule
  │   │   ├─ One-shot / aged recurring: delete task
  │   │   └─ Insert system message: "Running scheduled task (Apr 13 2:30pm)"
  │   └─ Otherwise: skip (not yet time)
  │
  └─ After tick: batch-write any lastFiredAt updates to disk
```

### Missed Task Handling (Startup Only)
When the scheduler loads file-backed tasks, it checks for one-shots whose `nextCronRunMs(cron, createdAt) < now`. These "missed while Claude was not running" tasks are surfaced to the user for confirmation (not auto-executed). They're deleted from `.claude/scheduled_tasks.json` regardless. Recurring tasks are NOT surfaced as missed — they just fire on the next tick.

---

## 8. Fire Routing

**File**: `hooks/useScheduledTasks.ts`

When a task fires, the `useScheduledTasks` hook routes it:

### Teammate Task
If `task.agentId` is set:
1. Look up the teammate by `agentId` in `store.getState().tasks`
2. If teammate found and not terminal: `injectUserMessageToTeammate(teammate.id, task.prompt)`
3. If teammate gone: log warning, `removeCronTasks([task.id])` (orphan cleanup)

### Lead Task
If no `agentId`:
1. Insert a system message: `"Running scheduled task (Apr 13 2:30pm)"`
2. Enqueue via `enqueuePendingNotification()` with:
   - `priority: 'later'` (drains between turns, not interrupting current work)
   - `isMeta: true` (hidden from queue preview and transcript UI in brief mode)
   - `workload: WORKLOAD_CRON` (lower QoS attribution for billing)
3. The REPL's command queue (`useCommandQueue`) drains these between turns

### Idle Gate
Jobs only fire while the REPL is idle (`isLoading() === false`), except in assistant mode where the gate is bypassed.

---

## 9. Jitter System

**File**: `utils/cronTasks.ts`

Jitter prevents thundering-herd scenarios where many sessions hit inference at the same wall-clock time.

### Deterministic Per-Task Seed
Task ID is an 8-hex UUID slice, parsed as u32 and normalized to [0, 1). This is stable across restarts and uniformly distributed.

### Recurring Task Jitter (Forward Delay)
- Delay = `jitterFrac(taskId) × recurringFrac × gapBetweenFires`
- Capped at `recurringCapMs` (default: 15 minutes)
- Default `recurringFrac` = 0.1 (10% of interval)
- Example: hourly task spreads fires across [:00, :06)

### One-Shot Task Jitter (Backward Lead)
- Only when fire time lands on a minute where `minute % oneShotMinuteMod === 0` (default: :00 and :30)
- Lead = `oneShotFloorMs + jitterFrac(taskId) × (oneShotMaxMs - oneShotFloorMs)`
- Default: 0 to 90 seconds early
- Clamped to `fromMs` so a task never fires before it was created
- Example: "remind me at 3:00pm" might fire at 2:58:30pm

### Runtime Config via GrowthBook
All jitter parameters are tunable at runtime via `tengu_kairos_cron_config`:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `recurringFrac` | 0.1 | Forward delay as fraction of interval |
| `recurringCapMs` | 15 × 60 × 1000 | Max forward delay (15 min) |
| `oneShotMaxMs` | 90 × 1000 | Max backward lead (90 sec) |
| `oneShotFloorMs` | 0 | Min backward lead |
| `oneShotMinuteMod` | 30 | Which minute marks get jitter |
| `recurringMaxAgeMs` | 7 × 24 × 60 × 60 × 1000 | Auto-expiry (7 days) |

---

## 10. Auto-Expiry

Recurring tasks auto-expire after **7 days** (`DEFAULT_MAX_AGE_DAYS`). When `isRecurringTaskAged()` returns true (i.e., `now - task.createdAt >= recurringMaxAgeMs`), the task fires one final time and is then deleted.

### Purpose
- Bounds session lifetime (p99 uptime was 53 hours post-#19931)
- Prevents unbounded recurrence that lets Tier-1 heap leaks compound
- Covers the common "check my PRs every hour this week" workflow

### Exception
Tasks with `permanent: true` never age out. These are system tasks (assistant mode's catch-up/morning-checkin/dream) that can't be recreated because `install.ts`'s `writeIfMissing()` skips existing files.

### Runtime Config
`recurringMaxAgeMs` is tunable via GrowthBook. Max 30 days enforced by Zod validation in `cronJitterConfig.ts`. Setting it to `0` means unlimited (never auto-expire).

---

## 11. Multi-Session Locking

**File**: `utils/cronTasksLock.ts`

When multiple Claude Code sessions run in the same project directory:

1. On `enable()`, the scheduler attempts `tryAcquireSchedulerLock()` — an O_EXCL atomic test-and-set on `.claude/scheduled_tasks.lock`
2. The lock file contains `{ sessionId, pid, acquiredAt }`
3. If another session holds the lock and its PID is still alive → this session stays passive, re-probes every 5 seconds
4. If the lock owner's PID is dead (crashed session) → a passive session recovers the stale lock
5. On session exit, `registerCleanup()` releases the lock

Only the lock owner processes file-backed tasks. Session-only tasks are always processed by the owning session (no cross-session visibility).

---

## 12. Immediate Execution

A critical detail from the `/loop` skill prompt:

> **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

This means `/loop 5m check the deploy` runs "check the deploy" right now, then schedules it to repeat every 5 minutes. This gives the user instant feedback rather than waiting for the first cron tick.

---

## 13. The `/loop` Skill Prompt (Full Text)

When `/loop` is invoked with arguments, `buildPrompt(args)` generates a detailed instruction prompt for the model. Key sections:

1. **Parsing instructions** (the 3-rule priority system described in §2)
2. **Interval-to-cron conversion table** (described in §3)
3. **Action instructions**: Call `CronCreate` with the parsed `cron`, `prompt`, and `recurring: true`
4. **Confirmation**: Briefly confirm what's scheduled, the cron expression, human-readable cadence, 7-day auto-expiry, and how to cancel
5. **Immediate execution**: Run the prompt right now (not waiting for first cron fire)

---

## 14. /loop vs ScheduleWakeup

These are **two separate systems**:

| Aspect | `/loop` (CronCreate) | ScheduleWakeup |
|--------|----------------------|----------------|
| Defined in | Client source code | Server-side system prompt |
| Storage | `.claude/scheduled_tasks.json` or in-memory | None (conversational) |
| Scheduler | Real 1s timer, file watcher, lock file | No scheduler |
| Persistence | Survives restarts (durable) or sessions | Dies with conversation |
| Self-pacing | Fixed interval | Model chooses delay dynamically (60–3600s) |
| Use case | Scheduled/recurring tasks | Dynamic iteration within a single turn |

When `/loop` is called **without an interval**, the model uses `ScheduleWakeup` to self-pace iterations. With an explicit interval, it creates a proper CronCreate-backed cron job.
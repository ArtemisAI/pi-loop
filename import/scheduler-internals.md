# Cron Scheduler Internals

> Deep dive into the cron scheduling engine: expression parsing, task lifecycle, storage, jitter, locking, and the 1-second check loop.
>
> **Last updated**: 2026-04-16 — revised after deep-dive against Claude Code v2.1.111 bundle analysis and pi-loop implementation comparison.

---

## 1. Cron Expression Engine

### 5-Field Format
All cron expressions use standard 5-field format in **local time**:

```
minute hour day-of-month month day-of-week
```

### Key Functions

| Function | Purpose |
|---|---|
| `parseCronExpression(cron)` | Validates and parses a 5-field cron string into structured field objects |
| `computeNextCronRun(fields, from)` | Computes the next matching time after `from`. Returns `null` if no match in the next year |
| `nextCronRunMs(cron, fromMs)` | Convenience: parse + compute, returning epoch ms or `null` |
| `cronToHuman(cron)` | Converts cron to human-readable (e.g., `"every 5 minutes"`) |
| `intervalToCron(interval)` | Converts human interval (`5m`, `2h`) to cron expression |
| `cronGapMs(cron, fromMs)` | Computes gap between consecutive fires (for jitter calculation) |

### Local Time Semantics
All cron evaluation is in the user's local timezone. No UTC conversion.

---

## 2. CronTask Definition

```typescript
type CronTask = {
  id: string                  // 8-hex UUID slice (e.g. "a3f2b9c1")
  cron: string                // 5-field cron string (local time)
  prompt: string              // Prompt to enqueue when the task fires
  createdAt: number           // Epoch ms when created
  lastFiredAt?: number        // Epoch ms of most recent fire
  recurring?: boolean         // true = reschedule after fire; false = one-shot
  permanent?: boolean         // true = exempt from auto-expiry (system tasks)
  durable?: boolean           // Runtime-only: false = session-only (never to disk)
  agentId?: string            // Runtime-only: route fires to teammate (never persisted)
}
```

### Field Notes

- **id**: 8 hex chars from UUID v4. Short because MAX_JOBS=50. Also used as jitter seed.
- **createdAt**: Anchor for missed-task detection and first-sight scheduling. Never-fired recurring tasks use this (not `now`) so pinned crons don't skip.
- **lastFiredAt**: Written after each recurring fire. Survives restarts for durable tasks. Never set for one-shots.
- **durable**: Stripped by `writeCronTasks()` before disk write. On-disk tasks are implicitly durable.
- **agentId**: Set when a teammate creates a cron. Never persisted.
- **permanent**: Only for assistant mode system tasks.

---

## 3. CRUD Operations

### addCronTask(cron, prompt, recurring, durable, agentId?)

```
addCronTask("*/5 * * * *", "check the deploy", true, false)
  |
  +-- id = randomUUID().slice(0, 8)
  +-- task = { id, cron, prompt, createdAt: Date.now(), recurring: true }
  +-- If !durable -> session store (STATE.sessionCronTasks)
  +-- If durable  -> read + write .claude/scheduled_tasks.json
```

### removeCronTask(ids[])
Removes from session store first, then from file if needed.

### listAllCronTasks()
Merges file-backed tasks + session tasks. Session tasks get `durable: false`.

### markCronTasksFired(ids[], firedAt)
Stamps `lastFiredAt` on file-backed tasks and writes back. Batched so N fires = one read-modify-write.

---

## 4. File Format

**`.claude/scheduled_tasks.json`**

```json
{
  "tasks": [
    {
      "id": "a3f2b9c1",
      "cron": "*/5 * * * *",
      "prompt": "check the deploy",
      "createdAt": 1712923200000,
      "lastFiredAt": 1712923500000,
      "recurring": true
    }
  ]
}
```

Keys on disk: `id`, `cron`, `prompt`, `createdAt`, `lastFiredAt?`, `recurring?`, `permanent?`.
Keys **absent**: `durable` (stripped), `agentId` (never persisted).

---

## 5. The Scheduler Daemon

### Lifecycle

```
createCronScheduler({ onFire, onFireTask, isLoading, getJitterConfig, isKilled })
  |
  +-- start()
  |   +-- Poll getScheduledTasksEnabled() every 1s until true
  |   +-- Acquire scheduler lock (O_EXCL)
  |   |   |-- Acquired -> isOwner = true
  |   |   +-- Failed -> passive mode, re-probe every 5s
  |   +-- Watch .claude/scheduled_tasks.json (chokidar, stabilityThreshold: 300ms)
  |   +-- Start 1-second setInterval(check)
  |
  +-- check() — every 1 second
  |   +-- Skip if killed or loading
  |   +-- Merge fileTasks + sessionTasks
  |   +-- For each: compute nextFire, apply jitter, fire if due
  |   +-- Batch-write lastFiredAt updates
  |
  +-- stop()
      +-- clearInterval, release lock, close watcher
```

### First-Sight Anchoring
Never-fired recurring tasks anchor from `createdAt` (not `now`). Critical for pinned crons.

### File Watcher (chokidar)
- Watches `.claude/scheduled_tasks.json` with `awaitWriteFinish: { stabilityThreshold: 300 }`
- On change: reload file tasks (does not re-surface missed tasks)
- Only the lock owner processes file-backed tasks

### pi-loop Equivalent
pi-loop uses `setInterval(check, 1000)` directly in `scheduler.ts` — same 1-second tick pattern. Does NOT have a file watcher (tasks are only loaded on startup). Uses `agent_start`/`agent_end` events for idle gating instead of Claude Code's `isLoading()` React hook.

---

## 6. Locking: Multi-Session Safety

### Claude Code Mechanism
```
tryAcquireSchedulerLock()
  |
  +-- Open .claude/scheduled_tasks.lock with O_EXCL (wx flag)
  |   |-- Success -> write { sessionId, pid, acquiredAt }
  |   +-- Fail -> lock already held
  |
  +-- If lock held:
      +-- Read lock file
      +-- Check PID liveness via process.kill(pid, 0)
      |   |-- PID alive -> lock is valid, wait
      |   +-- PID dead -> stale lock, recover
      +-- registerCleanup() -> release on process exit
```

### pi-lock Comparison
pi-loop's `store.ts` implements the same O_EXCL pattern but uses `STALE_LOCK_MS = 30_000` instead of PID liveness checking. This is the bug in Issue #1.

| Aspect | Claude Code | pi-loop |
|---|---|---|
| Lock acquisition | O_EXCL (`open(path, "wx")`) | Same |
| Stale detection | `process.kill(pid, 0)` | `Date.now() - acquiredAt > 30s` |
| Lock content | `{ sessionId, pid, acquiredAt }` | `{ pid, acquiredAt }` |
| Re-probe interval | 5 seconds | None (fails immediately) |
| Lock release | `registerCleanup()` on exit | `releaseLock()` on shutdown event |

---

## 7. Missed Task Handling

On startup, `findMissedTasks()` checks for durable one-shot tasks whose `nextCronRunMs(cron, createdAt) < now`.

1. After loading file-backed tasks, check for missed one-shots
2. If `onFire` callback provided, surface for user confirmation (not auto-executed)
3. Delete missed tasks from `.claude/scheduled_tasks.json`
4. Recurring tasks are NOT surfaced — they just fire on the next tick

pi-loop does not implement missed task handling (see CR-001).

---

## 8. Jitter System

### Why Jitter?
Without jitter, many sessions scheduling `0 * * * *` would all hit the API at exactly :00.

### Claude Code Production Defaults (v2.1.111)

| Parameter | Value | Purpose |
|---|---|---|
| `recurringFrac` | **0.5** | 50% of interval as forward delay |
| `recurringCapMs` | **1,800,000** | 30 min max delay |
| `oneShotMaxMs` | 90,000 | 90 sec max early fire |
| `oneShotFloorMs` | 0 | Min early fire |
| `oneShotMinuteMod` | 30 | Jitter :00 and :30 only |
| `recurringMaxAgeMs` | 604,800,000 | 7 days auto-expiry |
| `cacheLeadMs` | 15,000 | Cache optimization |

### pi-loop Defaults

| Parameter | Value | Gap |
|---|---|---|
| `recurringFrac` | 0.1 | 5x less spread |
| `recurringCapMs` | 900,000 | Half the cap |
| `oneShotMaxMs` | 90,000 | Aligned |
| `oneShotFloorMs` | 0 | Aligned |
| `oneShotMinuteMod` | 30 | Aligned |
| `recurringMaxAgeMs` | 604,800,000 | Aligned |

### Configurable at Runtime (Claude Code)
All jitter parameters are sourced from GrowthBook feature flag `tengu_kairos_cron_config` with Zod validation and 60-second cache TTL. pi-loop uses hardcoded defaults.

---

## 9. Auto-Expiry

```typescript
function isRecurringTaskAged(t, nowMs, maxAgeMs): boolean {
  if (maxAgeMs === 0) return false;  // unlimited
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs);
}
```

- Default: 7 days. Max configurable: 30 days.
- `permanent: true` tasks never expire.
- Telemetry event: `tengu_scheduled_task_expired` with `{ taskId, ageHours }`.

---

## 10. ScheduleWakeup (Not Cron-Based)

ScheduleWakeup is a separate system for dynamic self-pacing:

| Parameter | Type | Description |
|---|---|---|
| `delaySeconds` | number | Clamped to [60, 3600] |
| `reason` | string | Telemetry explanation |
| `prompt` | string | The loop input to fire on wake-up |

- `<<autonomous-loop-dynamic>>` sentinel for runtime resolution
- Cache-aware: 300s cache TTL means 1200-1800s recommended for idle ticks
- Also auto-expires after `recurringMaxAgeMs`
- Telemetry: `tengu_loop_dynamic_wakeup_aged_out`

pi-loop does not implement ScheduleWakeup (see MD-009).

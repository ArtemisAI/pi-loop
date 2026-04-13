# Cron Scheduler Internals

> Deep dive into the cron scheduling engine: expression parsing, task lifecycle, storage, jitter, locking, and the 1-second check loop.

---

## 1. Cron Expression Engine

**File**: `utils/cron.ts` (9.5KB)

### 5-Field Format
All cron expressions use standard 5-field format in **local time**:

```
minute hour day-of-month month day-of-week
```

Examples:
- `*/5 * * * *` → every 5 minutes
- `0 */2 * * *` → every 2 hours
- `30 14 27 2 *` → February 27 at 2:30 PM local
- `0 9 * * 1-5` → weekdays at 9 AM

### Key Functions

| Function | Purpose |
|----------|---------|
| `parseCronExpression(cron)` | Validates and parses a 5-field cron string into structured field objects. Returns `null` if invalid. |
| `computeNextCronRun(fields, from)` | Given parsed fields and a `Date`, computes the next matching time. Returns `null` if no match in the next year. |
| `nextCronRunMs(cron, fromMs)` | Convenience wrapper: parse + compute, returning epoch ms or `null`. |
| `cronToHuman(cron)` | Converts cron expression to human-readable string (e.g., `"every 5 minutes"`, `"weekdays at 9:00 AM"`). |

### Local Time Semantics
All cron evaluation is in the user's local timezone. No UTC conversion happens. This means:
- `0 9 * * *` = 9:00 AM in whatever timezone the user is in
- In half-hour offset zones (India UTC+5:30), local :00 is UTC :30

---

## 2. CronTask Definition

**File**: `utils/cronTasks.ts`

```typescript
type CronTask = {
  id: string                  // 8-hex UUID slice (e.g. "a3f2b9c1")
  cron: string                // 5-field cron string (local time)
  prompt: string              // Prompt to enqueue when the task fires
  createdAt: number           // Epoch ms when created (anchor for missed detection)
  lastFiredAt?: number        // Epoch ms of most recent fire (written back by scheduler)
  recurring?: boolean         // true = reschedule after fire; false/undefined = one-shot
  permanent?: boolean         // true = exempt from auto-expiry (system tasks only)
  durable?: boolean           // Runtime-only: false = session-only (never written to disk)
  agentId?: string            // Runtime-only: route fires to this teammate (never persisted)
}
```

### Field Notes

- **id**: 8 hex chars from UUID v4. Short because MAX_JOBS=50, collision risk is negligible. Also used as jitter seed (parsed as u32 for deterministic delay).
- **createdAt**: The anchor for missed-task detection and first-sight scheduling. Never-fired recurring tasks use this (not `now`) so that pinned crons like `30 14 27 2 *` don't skip to next year.
- **lastFiredAt**: Written back by the scheduler after each recurring fire. Survives process restarts for durable tasks (stored in `.claude/scheduled_tasks.json`). Never set for one-shots (they're deleted on fire).
- **durable**: Stripped by `writeCronTasks()` before disk write. On-disk tasks are implicitly durable.
- **agentId**: Set when a teammate creates a cron. The scheduler routes fires to that teammate's queue. Never persisted (teammate crons are always session-only).
- **permanent**: Only set by `src/assistant/install.ts` via `writeIfMissing()`. Assistant mode's catch-up/morning-checkin/dream tasks use this because they can't be recreated.

---

## 3. CRUD Operations

**File**: `utils/cronTasks.ts`

### addCronTask(cron, prompt, recurring, durable, agentId?)

```
addCronTask("*/5 * * * *", "check the deploy", true, false)
  │
  ├─ id = randomUUID().slice(0, 8)  → "a3f2b9c1"
  │
  ├─ task = { id, cron, prompt, createdAt: Date.now(), recurring: true }
  │
  ├─ If !durable:
  │   └─ addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
  │     └─ STATE.sessionCronTasks.push(task)
  │
  └─ If durable:
      ├─ tasks = await readCronTasks()   // read from .claude/scheduled_tasks.json
      ├─ tasks.push(task)
      └─ await writeCronTasks(tasks)     // write back to .claude/scheduled_tasks.json
```

### removeCronTask(ids[])

```
removeCronTasks(["a3f2b9c1"])
  │
  ├─ If dir === undefined (REPL path):
  │   ├─ removeSessionCronTasks(ids)  // try session store first
  │   └─ If some IDs remain → readCronTasks() + filter + writeCronTasks()
  │
  └─ If dir !== undefined (daemon path):
      └─ readCronTasks(dir) + filter + writeCronTasks(dir)
         (never touches session store)
```

### listAllCronTasks()

Returns merged array of file-backed tasks + session tasks. Session tasks get `durable: false`. File tasks come as-is (durable is `undefined` → truthy).

### markCronTasksFired(ids[], firedAt)

After a recurring fire, stamps `lastFiredAt = now` on matching file-backed tasks and writes back. Batched so N fires in one scheduler tick = one read-modify-write. Only touches file-backed tasks (session tasks don't need persistence of fire time).

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
    },
    {
      "id": "f4e8c2d7",
      "cron": "30 14 27 2 *",
      "prompt": "remind me to file taxes",
      "createdAt": 1711516800000
    }
  ]
}
```

Keys present on disk: `id`, `cron`, `prompt`, `createdAt`, `lastFiredAt?` (recurring only), `recurring?`, `permanent?`. 

Keys **absent** on disk: `durable` (stripped by `writeCronTasks`), `agentId` (never persisted).

The directory `.claude/` is created if missing (`mkdir` with `{ recursive: true }`). Empty task lists write an empty file rather than deleting it, so the file watcher sees the change event on last-task-removed.

---

## 5. The Scheduler Daemon

**File**: `utils/cronScheduler.ts` (21KB)

### Lifecycle

```
createCronScheduler({ onFire, onFireTask, isLoading, assistantMode, getJitterConfig, isKilled })
  │
  ├─ start()
  │   ├─ If !assistantMode: poll getScheduledTasksEnabled() every 1s until true
  │   ├─ If assistantMode: auto-enable immediately
  │   ├─ Try acquire scheduler lock (O_EXCL on .claude/scheduled_tasks.lock)
  │   │   ├─ Acquired → isOwner = true → process file-backed tasks
  │   │   └─ Failed → stay passive, re-probe every 5s
  │   ├─ Watch .claude/scheduled_tasks.json with chokidar
  │   │   └─ awaitWriteFinish: { stabilityThreshold: 300 }
  │   └─ Start 1-second setInterval(check)
  │
  ├─ check() — called every 1 second
  │   │
  │   ├─ If isKilled() → skip (GrowthBook kill switch)
  │   ├─ If isLoading() && !assistantMode → skip (REPL busy)
  │   │
  │   ├─ Merge: fileTasks (if isOwner) + sessionTasks
  │   │
  │   ├─ For each task:
  │   │   ├─ If first seen: compute nextFireAt from lastFiredAt ?? createdAt
  │   │   ├─ If now >= nextFireAt:
  │   │   │   ├─ Route: agentId? → teammate : lead
  │   │   │   ├─ Recurring + not aged: stamp lastFiredAt, reschedule
  │   │   │   ├─ One-shot / aged recurring: remove task
  │   │   │   └─ Insert system message: "Running scheduled task (Apr 13 2:30pm)"
  │   │   └─ Otherwise: skip
  │   │
  │   └─ Batch-write any lastFiredAt updates to disk
  │
  └─ stop()
      ├─ clearInterval(checkTimer)
      ├─ Release scheduler lock
      ├─ Close chokidar watcher
      └─ Cleanup
```

### First-Sight Anchoring

Never-fired recurring tasks anchor from `createdAt` (not `now`). This is critical for pinned crons: if a task for `30 14 27 2 *` (Feb 27 at 2:30 PM) is created on Jan 15, anchoring from `now` would correctly find the next fire on Feb 27. But if we anchored from `createdAt` using `now` on a later date, it might skip to next year. The `createdAt` anchor ensures the first computation always starts from when the task was made.

### File Watcher (chokidar)

- Watches `.claude/scheduled_tasks.json` for add/change/unlink events
- `awaitWriteFinish: { stabilityThreshold: 300 }` prevents partial-write reads
- On change: `load(false)` reloads the file tasks (but does not re-surface missed tasks)
- Only one session holds the scheduler lock and processes file-backed tasks

---

## 6. Locking: Multi-Session Safety

**File**: `utils/cronTasksLock.ts` (6KB)

### Mechanism

```
tryAcquireSchedulerLock()
  │
  ├─ Open .claude/scheduled_tasks.lock with O_EXCL (wx flag)
  │   ├─ Success → write { sessionId, pid, acquiredAt }
  │   └─ Fail → lock already held
  │
  ├─ If lock held:
  │   ├─ Read lock file
  │   ├─ If PID is alive → another session owns it
  │   └─ If PID is dead → stale lock from crashed session
  │       ├─ Delete stale lock file
  │       └─ Retry acquire (up to N attempts)
  │
  └─ registerCleanup() → release lock on process exit
```

### Behavior

- **Lock owner**: Processes file-backed tasks, writes `lastFiredAt`, removes completed tasks from disk
- **Non-owner (passive)**: Does NOT process file-backed tasks. Re-probes lock every 5 seconds. Can still process session-only tasks (no coordination needed — each session owns its own session tasks)
- **Stale lock recovery**: If the lock owner's PID is dead, a passive session detects this and recovers the lock

---

## 7. Missed Task Handling

On scheduler startup, `findMissedTasks()` checks for durable one-shot tasks whose `nextCronRunMs(cron, createdAt) < now`. These are tasks that were supposed to fire while Claude was not running.

### Flow

1. After loading file-backed tasks, check for missed one-shots
2. If `onFire` callback is provided, surface them for user confirmation (not auto-executed)
3. Delete missed tasks from `.claude/scheduled_tasks.json` regardless of user action
4. Recurring tasks are NOT surfaced as missed — they just fire on the next tick

---

## 8. Jitter System

**File**: `utils/cronTasks.ts`

### Why Jitter?
Without jitter, many sessions scheduling `0 * * * *` would all hit the inference API at exactly :00. The jitter system spreads these out.

### Deterministic Per-Task Seed
```typescript
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}
```
- 8-hex UUID prefix parsed as u32 → normalized to [0, 1)
- Stable across restarts (same task ID → same jitter)
- Uniformly distributed across the fleet
- Non-hex IDs (hand-edited JSON) fall back to 0 (no jitter)

### Recurring: Forward Delay
```typescript
nextFire = baseFire + jitterFrac(taskId) * recurringFrac * gapBetweenFires
// capped at recurringCapMs
```

| Parameter | Default | Effect |
|-----------|---------|--------|
| `recurringFrac` | 0.1 | Delay = 10% of interval |
| `recurringCapMs` | 900000 (15 min) | Max delay |

Example: An hourly task with ID `"a3f2b9c1"` (`jitterFrac ≈ 0.64`) would fire 3.84 minutes late (0.64 × 0.1 × 60min).

### One-Shot: Backward Lead
```typescript
if (fireMinute % oneShotMinuteMod !== 0) return fireTime  // no jitter
lead = oneShotFloorMs + jitterFrac(taskId) * (oneShotMaxMs - oneShotFloorMs)
return max(fireTime - lead, fromMs)  // never fire before creation
```

| Parameter | Default | Effect |
|-----------|---------|--------|
| `oneShotMinuteMod` | 30 | Only jitter :00 and :30 marks |
| `oneShotMaxMs` | 90000 (90 sec) | Max early fire |
| `oneShotFloorMs` | 0 | Min early fire |

Example: A one-shot at 3:00 PM with ID `"f4e8c2d7"` (`jitterFrac ≈ 0.96`) would fire ~86 seconds early ≈ 2:58:34 PM.

### Configurable at Runtime
All jitter parameters are sourced from GrowthBook feature flag `tengu_kairos_cron_config` with Zod validation:

```typescript
const JitterConfigSchema = z.object({
  recurringFrac: z.number().min(0).max(1).default(0.1),
  recurringCapMs: z.number().min(0).default(15 * 60 * 1000),
  oneShotMaxMs: z.number().min(0).default(90 * 1000),
  oneShotFloorMs: z.number().min(0).default(0),
  oneShotMinuteMod: z.number().min(1).max(60).default(30),
  recurringMaxAgeMs: z.number().min(0).max(30 * 24 * 60 * 60 * 1000).default(7 * 24 * 60 * 60 * 1000),
})
```

This allows ops to adjust behavior fleet-wide without shipping a client build. During an incident, they could push `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}` to spread :00/:15/:30/:45 fires across a [t-5min, t-30s] window.

---

## 9. Auto-Expiry

```typescript
function isRecurringTaskAged(t: CronTask, nowMs: number, maxAgeMs: number): boolean {
  if (maxAgeMs === 0) return false  // unlimited
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}
```

### Behavior

- Recurring tasks created more than `recurringMaxAgeMs` ago (default: 7 days) fire one final time, then are deleted
- `permanent: true` tasks never expire (assistant mode system tasks)
- `recurringMaxAgeMs: 0` means unlimited (never auto-expire)
- Max configurable value: 30 days (enforced by Zod schema)
- In the `/loop` skill, the model is instructed: *"Tell the user about the 7-day limit when scheduling recurring jobs"*

---

## 10. CronDelete and CronList

### CronDeleteTool

**File**: `tools/ScheduleCronTool/CronDeleteTool.ts`

- Validates the job ID exists
- Calls `removeCronTask([id])` which sweeps both session store and disk
- Returns human-readable confirmation with the deleted task's schedule

### CronListTool

**File**: `tools/ScheduleCronTool/CronListTool.ts`

- Calls `listAllCronTasks()` which merges file-backed + session tasks
- Returns formatted list with ID, schedule (human-readable), prompt, recurring status, durable status
# pi-loop-dev Known Issues and Technical Debt

> Internal development document — tracks bugs, design gaps, and future work.
> For public-facing summary, see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
>
> **Last updated**: 2026-04-16 — all fixable issues resolved for v0.2.0.

---

## Issue Classification

| Severity | Description |
|----------|-------------|
| Critical | Data loss, security, or broken core functionality |
| High | Incorrect behavior affecting reliability |
| Medium | Missing features, degraded UX, maintenance debt |
| Low | Polish, documentation, minor improvements |

---

## Critical Issues

### CR-001: No Missed One-Shot Recovery

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/store.ts` -> `loadDurableTasks()`, `src/index.ts` -> session_start handler
**Since:** v0.1.0
**Impact:** Data Loss

#### Description
When durable one-shot tasks are scheduled and the agent is offline at fire time, they are silently lost. Claude Code detects these on startup via `findMissedTasks()` and surfaces them for user confirmation.

#### Current Behavior
```typescript
// src/index.ts - session_start handler
const durableTasks = await loadDurableTasks(cwd, config);
for (const task of durableTasks) {
  addTask(task);  // Blindly loads all tasks, no missed-fire detection
}
```

#### Expected Behavior
1. Load durable tasks
2. For each one-shot task, check if `now > scheduledFireTime`
3. If missed: surface to user, fire immediately, or log and remove

#### Claude Code Reference
Claude Code's `findMissedTasks()` filters for non-recurring tasks whose `nextCronRunMs(cron, createdAt) < now`. These are surfaced with a message: "The following one-shot scheduled task(s) were missed while Claude was not running..."

#### Fix Approach
1. One-shot tasks already store `nextFireTime` in the schema (added in types.ts)
2. In `loadDurableTasks()` or after loading, detect one-shots where `now > nextFireTime`
3. Emit a notification or prompt user for action
4. Remove the missed task from the durable file

---

## High Issues

### HI-001: Stale Lock Timeout Too Short (PID Liveness Bug)

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/store.ts:158-165` (isPidAlive), `src/store.ts:167-200` (acquireLock)
**Since:** v0.1.0
**Impact:** Multi-Instance Safety — lock can be stolen while owner is still alive

#### Root Cause
The lock uses `STALE_LOCK_MS = 30_000` (30 seconds) as the only staleness criterion. Session-lifetime locks are held for hours, so any second instance launched after 30s will break the lock.

#### Current Behavior
```typescript
const STALE_LOCK_MS = 30_000;

// On EEXIST:
if (Date.now() - lock.acquiredAt > STALE_LOCK_MS) {
  await unlink(path);           // Breaks lock even if owner is alive!
  return acquireLock(cwd, config);
}
```

#### Claude Code's Approach
Claude Code uses **PID liveness checking** instead of timestamps:
1. Read lock file -> get owner PID
2. Check if PID is alive via `process.kill(pid, 0)` (signal 0 = existence check)
3. If PID alive -> lock is valid, wait
4. If PID dead -> stale lock from crashed session, safe to recover

#### Proposed Fix
Replace timestamp-based staleness with PID liveness:
```typescript
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;   // PID exists — lock owner is alive
  } catch {
    return false;  // PID doesn't exist — stale lock
  }
}

// In acquireLock on EEXIST:
const lock = JSON.parse(await readFile(path, "utf-8"));
if (isPidAlive(lock.pid)) {
  return false;   // Owner is alive — cannot acquire
}
// Owner is dead — recover stale lock
await unlink(path);
return acquireLock(cwd, config);
```

#### Testing Plan
1. Unit tests: mock `process.kill` for alive/dead PID scenarios
2. Integration tests: two sessions in same directory
3. Manual test on dev-1: launch two pi instances, verify lock behavior

---

### HI-002: No Session Resume Reconstruction

**Status:** Fixed (v0.2.0)
**Location:** `src/index.ts` -> session_before_compact / session_compact handlers
**Since:** v0.1.0
**Impact:** Data Loss on compaction

#### Description
Session-only tasks are lost when conversation history is compacted. Claude Code reconstructs them by scanning tool call history for CronCreate/CronDelete calls after compaction.

#### Claude Code Reference
After compaction or session resume, Claude Code's `AYA` function:
1. Iterates all tool calls in conversation history
2. Maps tool results back to their inputs
3. Skips durable tasks (already persisted)
4. Skips already-deleted tasks
5. Recreates surviving session-only tasks in memory

#### Fix Approach
Use `pi.on("session_before_compact")` to snapshot session-only tasks, then `pi.on("session_compact")` to restore them.

---

## Medium Issues

### MD-001: Config File Not Loaded

**Status:** Fixed (v0.2.0)
**Location:** `src/index.ts` -> loadProjectConfig()
**Since:** v0.1.0
**Impact:** User Experience

#### Description
`config/default.json` exists but is never loaded at runtime. All configuration is hardcoded in `DEFAULT_CONFIG`.

#### Fix Approach
Create `src/config.ts` that loads config from `.pi-loop.config.json` (project-level) falling back to `DEFAULT_CONFIG`.

---

### MD-002: Test Harness Compatibility Shim Required

**Status:** Fixed (v0.2.0)
**Location:** `tests/integration/harness-patch.ts`
**Since:** v0.1.0
**Impact:** Maintenance

#### Description
Harness patch now has try/catch guard, null checks on state, and a TODO to track removal.

---

### MD-003: Silent Error Handling in Store Operations

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/store.ts`
**Since:** v0.1.0
**Impact:** Debugging

#### Description
File operations catch all errors and return empty/default values without logging.

#### Fix Approach
Distinguish ENOENT (expected) from real errors and log the latter.

---

### MD-004: No Scheduler Unit Tests

**Status:** Fixed (v0.1.2-dev)
**Location:** `tests/unit/scheduler.test.ts`
**Since:** v0.1.0
**Impact:** Quality Assurance

#### Description
`scheduler.ts` (167 lines) has zero unit tests. Untested paths: `shouldFire()`, `fire()`, `drainPendingFires()`, `isAgedOut()`, state transitions.

---

### MD-005: Duplicate Task ID Silently Overwrites

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/store.ts:33-42`
**Since:** v0.1.0
**Impact:** Data Integrity

#### Description
`addTask()` uses `Map.set()` which silently overwrites existing entries.

---

### MD-006: Lock File Name Mismatch

**Status:** Fixed (v0.2.0)
**Location:** `docs/loop-extension-design.md`
**Since:** v0.1.0
**Impact:** Documentation

#### Description
All docs now correctly reference `.pi-loop.json.lock`. No actual mismatch remains.

---

### MD-007: Jitter Defaults Too Conservative

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/types.ts:36-37`
**Since:** v0.1.0
**Impact:** Thundering-Herd Protection

#### Description
pi-loop's recurring jitter is 10% with a 15-minute cap. Claude Code uses 50% with a 30-minute cap. The lower values provide less protection against API load spikes when many agents schedule tasks at the same interval.

| Parameter | Claude Code | pi-loop |
|---|---|---|
| `recurringFrac` | **0.5** | 0.1 |
| `recurringCapMs` | **1,800,000** (30 min) | 900,000 (15 min) |

#### Fix Approach
Bump defaults to match Claude Code:
```typescript
recurringJitterFrac: 0.5,
recurringJitterCapMs: 30 * 60 * 1000,
```

---

### MD-008: No File Watcher for Durable Tasks

**Status:** Fixed (v0.2.0)
**Location:** `src/index.ts` -> session_start file watcher
**Since:** v0.1.0
**Impact:** Multi-Instance Coordination

#### Description
pi-loop only reads durable tasks on startup. If another process modifies `.pi-loop.json`, the change isn't detected until restart.

#### Claude Code Reference
Uses `chokidar` file watcher with `awaitWriteFinish: { stabilityThreshold: 300 }` to hot-reload durable task changes.

#### Fix Approach
Use `fs.watch()` or `chokidar` on `.pi-loop.json` to detect external changes.

---

### MD-009: No ScheduleWakeup / Dynamic Pacing

**Status:** Fixed (v0.2.0)
**Location:** `src/schedule-wakeup.ts`, `src/index.ts` -> /loop dynamic mode
**Since:** v0.1.0
**Impact:** Feature Gap

#### Description
Claude Code has a second scheduling mechanism: `/loop` without an interval enters dynamic self-pacing mode using the `ScheduleWakeup` tool. The model chooses its own delay (clamped to 60-3600 seconds), and on each wake-up decides whether to continue or stop.

pi-loop has no equivalent — all loops are cron-based.

#### Claude Code Reference
- `ScheduleWakeup` tool: `delaySeconds`, `reason`, `prompt` parameters
- `<<autonomous-loop-dynamic>>` sentinel for runtime resolution
- Cache-aware delay guidance: 1200-1800s default to avoid burning the 5-minute prompt cache
- ScheduleWakeup loops also auto-expire after `recurringMaxAgeMs`

#### Fix Approach
This is a significant feature addition. Requires:
1. New `schedule_wakeup` tool registration
2. Integration with pi-agent's turn lifecycle for wake-up delivery
3. Self-pacing logic in the prompt template
4. Cache TTL awareness in delay recommendations

---

### MD-010: No Monitor Tool Integration

**Status:** Open
**Location:** Global (new feature)
**Since:** v0.1.0
**Impact:** Feature Gap

#### Description
Claude Code's `/loop` can pair with a `Monitor` tool as the wake signal instead of just timers. pi-loop has no equivalent.

---

## Low Issues

### LW-001: Jitter Function Doc Comment Mismatch

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/jitter.ts:35-40`
**Since:** v0.1.0
**Impact:** Documentation

#### Description
Doc says "returns a negative offset" but function returns a positive value. The scheduler correctly subtracts it.

---

### LW-002: No Logging/Debug Mode

**Status:** Fixed (v0.2.0)
**Location:** `src/index.ts`, `src/scheduler.ts`, `src/store.ts`
**Since:** v0.1.0
**Impact:** Debugging

#### Description
Extension has no debug logging capability.

#### Fix Approach
```typescript
if (process.env.PI_LOOP_DEBUG) {
  console.debug(`[pi-loop] ...`);
}
```

---

### LW-003: cron_create Missing Label Parameter

**Status:** Fixed (v0.1.2-dev)
**Location:** `src/tools/cron-tools.ts`
**Since:** v0.1.0
**Impact:** UX

#### Description
`LoopTask` schema has an optional `label` field, but `cron_create` doesn't accept it as a parameter.

---

## Feature Parity Summary

Comparison against Claude Code's scheduling system:

| Feature | Claude Code | pi-loop | Priority |
|---|---|---|---|
| `/loop` command | Yes | Yes | -- |
| CronCreate/Delete/List tools | Yes | Yes | -- |
| 5-field cron parser | Yes | Yes | -- |
| 1s tick scheduler | Yes | Yes | -- |
| Deterministic jitter | Yes | Yes | -- |
| Idle gating | Yes | Yes | -- |
| Pending fires + drain | Yes | Yes | -- |
| Auto-expiry (7d) | Yes | Yes | -- |
| Durable persistence | Yes | Yes | -- |
| O_EXCL file lock | Yes | Yes (bug) | -- |
| PID-based lock liveness | Yes | No | High (HI-001) |
| Missed one-shot detection | Yes | No | Critical (CR-001) |
| Session resume reconstruction | Yes | No | High (HI-002) |
| ScheduleWakeup tool | Yes | No | Medium (MD-009) |
| Dynamic self-pacing | Yes | No | Medium (MD-009) |
| File watcher for durable tasks | Yes | No | Medium (MD-008) |
| Monitor integration | Yes | No | Low (MD-010) |
| Jitter defaults (50%/30min) | Yes | No (10%/15min) | Medium (MD-007) |
| Max 50 jobs | Yes | Yes | -- |
| Immediate first execution | Yes | Yes | -- |
| Prompt cache awareness | Yes | No | Low (part of MD-009) |

### Reference: claw-code (Rust re-implementation)
For context, claw-code's cron is a purely in-memory data registry with no scheduler, no tick loop, and no automatic execution. pi-loop is ahead of claw-code in scheduling capabilities.

---

## Issue Tracking

| ID | Severity | Summary | Status | GitHub Issue | Last Updated |
|----|----------|---------|--------|--------------|--------------|
| CR-001 | Critical | No missed one-shot recovery | **Fixed** | -- | 2026-04-16 |
| HI-001 | High | Lock stale timeout too short (PID bug) | **Fixed** | [#1](https://github.com/ArtemisAI/pi-loop-DEV/issues/1) | 2026-04-16 |
| HI-002 | High | No session resume reconstruction | **Fixed** | -- | 2026-04-16 |
| MD-001 | Medium | Config file not loaded | **Fixed** | -- | 2026-04-16 |
| MD-002 | Medium | Test harness compatibility shim | **Fixed** | -- | 2026-04-16 |
| MD-003 | Medium | Silent error handling in store | **Fixed** | -- | 2026-04-16 |
| MD-004 | Medium | No scheduler unit tests | **Fixed** | -- | 2026-04-16 |
| MD-005 | Medium | Duplicate task ID overwrites | **Fixed** | -- | 2026-04-16 |
| MD-006 | Medium | Lock file name mismatch in docs | **Fixed** | -- | 2026-04-16 |
| MD-007 | Medium | Jitter defaults too conservative | **Fixed** | -- | 2026-04-16 |
| MD-008 | Medium | No file watcher for durable tasks | **Fixed** | -- | 2026-04-16 |
| MD-009 | Medium | No ScheduleWakeup / dynamic pacing | **Fixed** | -- | 2026-04-16 |
| MD-010 | Medium | No Monitor tool integration | Open | Planned | 2026-04-16 |
| LW-001 | Low | Jitter doc comment mismatch | **Fixed** | -- | 2026-04-16 |
| LW-002 | Low | No debug logging | **Fixed** | -- | 2026-04-16 |
| LW-003 | Low | cron_create missing label param | **Fixed** | -- | 2026-04-16 |
| LW-004 | Low | cronToHuman midnight fallback | Open | [#12](https://github.com/ArtemisAI/pi-loop-DEV/issues/12) | 2026-04-17 |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-17 | Added LW-004: cronToHuman('0 0 * * *') returns 'daily at 12:00 AM' not 'every day at midnight'. Found by E2E test suite. |
| 2026-04-16 | Implementation sprint: fixed CR-001, HI-001, MD-003, MD-004, MD-005, MD-007, LW-001, LW-003. 86 tests passing. |
| 2026-04-16 | Major revision: regraded issues by severity, added HI-001/HI-002, added MD-007 through MD-010, LW-003; added feature parity table; added Claude Code and claw-code references |
| 2026-04-16 | Initial issue audit completed |

# Known Limitations

This document lists current limitations and areas for future improvement in @pi-agents/loop.

> **Last updated**: 2026-04-17 (v0.3.1)

---

## Scheduling

**No Monitor Tool Integration:** Claude Code's `/loop` can pair with a `Monitor` tool as the wake signal instead of just timers. pi-loop has no equivalent.

**Workaround:** Use `schedule_wakeup` with the appropriate delay to approximate polling-based monitoring.

---

## Loop Cancellation

**Fuzzy Match Ambiguity:** When `/loop-kill <query>` matches multiple tasks by label, prompt, or cron description, the command lists them and requires the user to specify an exact ID or use `/loop-kill all`. Single matches are resolved automatically.

---

## Durable Persistence

**File Watcher Uses `fs.watchFile` Polling:** The durable file watcher uses Node.js `watchFile` with a 5-second polling interval rather than native `fs.watch` or `chokidar`. This means external changes to `.pi-loop.json` can take up to 5 seconds to be detected.

---

## Session Lifecycle

**Compaction Recovery Is Best-Effort:** Session-only tasks survive conversation compaction via a snapshot/restore mechanism. However, if a task is deleted and then the session is compacted, the snapshot may restore a task that was intentionally cancelled. This is a known trade-off — durable tasks should be used for mission-critical scheduling.

---

## Platform

**No Windows Testing:** pi-loop is developed and tested on Linux/macOS. File locking behavior (`O_EXCL`) and PID liveness checks (`process.kill(pid, 0)`) may behave differently on Windows.

---

## Resolved in v0.3.x

The following limitations were addressed in v0.3.0–v0.3.1:

| Previous Limitation | Resolution | Version |
|---------------------|------------|---------|
| No dynamic self-pacing (ScheduleWakeup) | ✅ `schedule_wakeup` tool + `/loop` dynamic mode | v0.3.0 |
| No missed one-shot recovery | ✅ Detected on load and fired immediately | v0.3.0 |
| Conservative jitter defaults (10%/15min) | ✅ Now 50%/30min — matches Claude Code | v0.3.0 |
| Lock uses timestamp staleness (bug) | ✅ PID-based liveness checking | v0.3.0 |
| No session resume reconstruction | ✅ Snapshot/restore on compaction | v0.3.0 |
| No file watcher for durable tasks | ✅ `watchFile` polling (5s interval) | v0.3.0 |
| Config file not loaded | ✅ `.pi-loop.config.json` project overrides | v0.3.0 |
| Silent error handling in store | ✅ Distinguishes ENOENT from real errors, logs后者 | v0.3.0 |
| No scheduler unit tests | ✅ 19 scheduler tests + 85 feature tests | v0.3.1 |
| No debug logging | ✅ `PI_LOOP_DEBUG=1` enables verbose logging | v0.3.0 |
| `cron_create` missing label parameter | ✅ `label` parameter added | v0.3.0 |
| Duplicate task ID silently overwrites | ✅ `addTask()` rejects duplicates | v0.3.0 |
| `cronToHuman("0 0 * * *")` returns "daily at 12:00 AM" | ✅ Now returns "every day at midnight" | v0.3.1 |

---

## Reporting Issues

If you encounter a bug or have a feature request, please open an issue at:
https://github.com/ArtemisAI/pi-loop/issues

When reporting, please include:
- Node.js version (`node --version`)
- Extension version (from `package.json`)
- Steps to reproduce
- Any relevant log output (set `PI_LOOP_DEBUG=1` for verbose logs)
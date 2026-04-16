# Known Limitations

This document lists current limitations and areas for future improvement in @pi-agents/loop.

---

## Scheduling

**No Dynamic Self-Pacing (ScheduleWakeup):** Claude Code supports `/loop` without an interval, entering a dynamic mode where the model chooses its own wake-up delay (60-3600s). pi-loop only supports cron-based scheduling with explicit intervals. The model can use `cron_create` to approximate this behavior, but the ergonomics are different.

**No Missed One-Shot Recovery:** Durable one-shot tasks that miss their scheduled fire time (e.g., agent was offline) are not automatically recovered or surfaced for user confirmation. Claude Code detects these on startup and notifies the user.

**Workaround:** Use recurring tasks instead of one-shots for critical scheduled work, or use `durable: false` for short-lived one-shots.

---

## Jitter

**Conservative Jitter Defaults:** pi-loop uses 10% recurring jitter with a 15-minute cap. Claude Code uses 50% with a 30-minute cap. The lower values provide less protection against API load spikes when many agents schedule at the same interval.

**Workaround:** This is configurable in source. Projects with many concurrent agents may want to increase `recurringJitterFrac` and `recurringJitterCapMs`.

---

## Multi-Instance Safety

**Lock Uses Timestamp Staleness (Bug):** The file lock uses a 30-second stale timeout. Session-lifetime locks can be held for hours, so a second instance launched after 30 seconds will break the lock. The fix is to use PID-based liveness checking.

**Workaround:** Avoid running multiple agent instances on the same project directory for extended periods.

---

## Session Lifecycle

**No Session Resume Reconstruction:** Session-only tasks are lost when conversation history is compacted. Claude Code reconstructs them by scanning tool call history. pi-loop does not have this recovery mechanism.

**No File Watcher:** Changes to `.pi-loop.json` made by external processes are not detected. Durable tasks are only loaded on startup.

---

## Configuration

**Config File Not Loaded:** Configuration values are hardcoded. Project-level configuration (`.pi-loop.config.json`) is not yet supported.

**Workaround:** None currently. Custom configuration requires modifying source defaults in `src/types.ts`.

---

## Error Handling

**Silent Failures:** File I/O errors (loading/saving durable tasks) are silently caught. File corruption or permission errors may result in tasks being lost without notification.

**Workaround:** Ensure proper file permissions and disk health.

---

## Testing

**No Scheduler Unit Tests:** The core scheduler logic (`src/scheduler.ts`) lacks dedicated unit tests. Integration tests cover tool registration but not scheduler internals like idle gating, jitter timing, and fire draining.

---

## Planned Improvements

| Feature | Priority | Status |
|---|---|---|
| PID-based lock liveness | High | Issue #1 |
| Missed one-shot recovery | High | Planned |
| Session resume reconstruction | High | Planned |
| ScheduleWakeup / dynamic pacing | Medium | Planned |
| File watcher for durable tasks | Medium | Planned |
| Bump jitter defaults (50%/30min) | Medium | Planned |
| Project-level config files | Medium | Planned |
| Scheduler unit tests | Medium | Planned |
| Debug logging mode | Low | Planned |
| Monitor tool integration | Low | Planned |
| cron_create label parameter | Low | Planned |

---

## Reporting Issues

If you encounter a bug or have a feature request, please open an issue at:
https://github.com/ArtemisAI/pi-loop/issues

When reporting, please include:
- Node.js version (`node --version`)
- Extension version (from `package.json`)
- Steps to reproduce
- Any relevant log output

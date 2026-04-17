# Changelog

All notable changes to **@pi-agents/loop** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.3.1] — 2026-04-17

### Added

- **Enhanced loop cancellation**: `/loop-kill` now supports fuzzy matching by label, prompt text, or cron description (case-insensitive); `/loop-kill all` to cancel every active loop; exact ID takes priority over fuzzy matches ([#1](https://github.com/ArtemisAI/pi-loop-DEV/issues/1))
- **`pi.image` field** in `package.json` for pi.dev registry discoverability

### Fixed

- **cronToHuman midnight expression**: `cronToHuman("0 0 * * *")` now returns `"every day at midnight"` instead of `"daily at 12:00 AM"` ([#12](https://github.com/ArtemisAI/pi-loop-DEV/issues/12))

### Changed

- **KNOWN_LIMITATIONS.md** fully rewritten to reflect v0.3.x resolution status

---

## [0.3.0] — 2026-04-16

### Added

- **`schedule_wakeup` tool** for model-driven dynamic self-pacing (60–3600s delays). Agents choose their own wake-up interval each turn, with cache-awareness guidance (MD-009)
- **Dynamic `/loop` mode**: `/loop <prompt>` (no interval) enters dynamic pacing mode instead of defaulting to 10m cron
- **PID-based lock liveness**: file lock now uses `process.kill(pid, 0)` instead of timestamp staleness, preventing lock theft from long-running sessions (HI-001, [#1](https://github.com/ArtemisAI/pi-loop-DEV/issues/1))
- **Missed one-shot recovery**: durable one-shot tasks missed while the agent was offline are detected on restart and fired immediately (CR-001)
- **Session compaction survival**: session-only tasks are snapshot before compaction and restored after, preventing task loss (HI-002)
- **File watcher for durable tasks**: `watchFile` polling (5s interval) detects external changes to `.pi-loop.json` (MD-008)
- **Project-level config loading**: `.pi-loop.config.json` overrides are now merged with defaults at session start (MD-001)
- **Debug logging**: set `PI_LOOP_DEBUG=1` for verbose `[pi-loop]` messages across all modules (LW-002)
- **`label` parameter** on `cron_create` for human-readable task names (LW-003)

### Fixed

- **Duplicate task ID rejection**: `addTask()` now returns `false` instead of silently overwriting existing entries (MD-005)
- **Jitter defaults match Claude Code**: `recurringJitterFrac` bumped from 0.1 → **0.5**; `recurringJitterCapMs` from 900,000 → **1,800,000** (50% / 30 min) (MD-007)
- **Error handling in store**: distinguishes ENOENT (expected) from real errors; logs the latter to `console.error` (MD-003)
- **Jitter doc comment**: `jitterFrac` docstring corrected (LW-001)
- **Lock file name**: documentation now consistently references `.pi-loop.json.lock` (MD-006)

### Tests

- **19 scheduler unit tests** covering fire logic, idle gating, age-out, and drain (MD-004)
- **85 v0.3.1 feature tests** covering all new functionality
- **54 E2E real-scheduler tests** with timing measurements
- **154 E2E published-package tests** validating the npm artifact

---

## [0.2.0] — 2026-04-16

### Added

- Session resume, config loading, file watcher, debug logging
- Scheduler unit tests: 18 tests covering fire logic, idle gating, expiry

### Fixed

- Test harness compatibility shim hardened (MD-002)
- Lock file name verified consistent across docs (MD-006)
- Jitter defaults bumped, docstring fixed, label param added

---

## [0.1.2] — 2026-04-16

### Fixed

- Missed one-shot recovery (CR-001)
- PID-based lock liveness stub (HI-001, partial)
- Silent error handling in store (MD-003)
- Scheduler unit tests added (MD-004)
- Duplicate task ID rejection (MD-005)
- Jitter defaults bumped (MD-007)
- Jitter doc comment (LW-001)
- cron_create label parameter (LW-003)

---

## [0.1.1] — 2026-04-15

### Fixed

- Added `nextFireTime` field for missed one-shot detection (CR-001, LW-003 partial)

---

## [0.1.0] — 2026-04-15

### Added

- Initial implementation: `/loop`, `/loop-list`, `/loop-kill` commands
- `cron_create`, `cron_delete`, `cron_list` LLM-callable tools
- 5-field cron parser with local timezone evaluation
- 1-second tick scheduler with idle gating
- Deterministic jitter system (recurring forward, one-shot backward)
- Auto-expiry (7-day default for recurring tasks)
- Durable persistence via `.pi-loop.json` with O_EXCL file locking
- Max 50 concurrent jobs
- 66 unit and integration tests

---

[0.3.1]: https://github.com/ArtemisAI/pi-loop/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ArtemisAI/pi-loop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ArtemisAI/pi-loop/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ArtemisAI/pi-loop/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ArtemisAI/pi-loop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ArtemisAI/pi-loop/releases/tag/v0.1.0
# pi-loop (@pi-agents/loop)

Recurring prompt scheduling extension for pi-coding-agent, ported from Claude Code's /loop system.

## General Instructions

- **Issue publishing**: Only open public issues on `ArtemisAI/pi-loop` when they relate to a published version. All development issues go on `ArtemisAI/pi-loop-DEV`.
- **Commit frequently**: Small atomic commits for each logical change.
- **Document as you go**: Update docs/ and import/ when behavior changes.
- **Save to memory**: Use claude-mem plugin for significant discoveries and decisions.
- **Test in sandbox**: Use pi-test-harness for unit/integration tests. For live testing, use isolated environments.

## Key Facts

- Package: `@pi-agents/loop` on npm (scoped, restricted)
- Framework: `@mariozechner/pi-coding-agent` extension API
- Test runner: Vitest (59 tests: 57 unit + 2 sandbox)
- Build: `tsc` -> `dist/`
- Lock file bug: Issue #1 on both repos — PID liveness fix pending

## Architecture

- `src/index.ts` — Extension entry, registers commands + lifecycle hooks
- `src/cron.ts` — 5-field cron parser + next-run calculator
- `src/scheduler.ts` — 1s tick loop, idle gating, fire dispatch
- `src/store.ts` — In-memory Map + .pi-loop.json + O_EXCL lock
- `src/jitter.ts` — Deterministic jitter (u32 seed from task ID)
- `src/types.ts` — LoopTask, LoopConfig types + defaults
- `src/parse-args.ts` — /loop 3-rule argument parser
- `src/tools/cron-tools.ts` — cron_create, cron_delete, cron_list tools

## Jitter Defaults (Target: match Claude Code)

Current pi-loop defaults are too conservative:
- `recurringJitterFrac`: 0.1 (should be **0.5**)
- `recurringJitterCapMs`: 900,000 (should be **1,800,000**)

## Priority Issues

1. HI-001: PID-based lock liveness (src/store.ts)
2. MD-007: Bump jitter defaults (src/types.ts)
3. MD-004: Scheduler unit tests
4. CR-001: Missed one-shot recovery
5. MD-003: Better error handling in store

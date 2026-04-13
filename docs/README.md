# pi-loop

A recurring execution and scheduling framework for AI agents, inspired by the Claude Code `/loop` system.

## What is pi-loop?

Pi-loop is a framework for building self-scheduling AI agent loops. It takes the core patterns of Claude Code's `/loop` system — cron-based scheduling, jitter-based anti-thundering-herd, multi-session safety, and auto-expiry — and makes them available as a general-purpose building block for AI agent orchestration.

### Why "pi"?

Pi (π) represents an infinite, non-repeating loop — the same precision that makes cron scheduling work. The loop never ends, but each iteration is unique.

## Design Principles

1. **Deterministic jitter over randomness** — Tasks with the same ID always jitter the same way, ensuring fleet-wide uniform distribution without coordination.
2. **Graceful degradation** — Session-only tasks survive process crashes via auto-expiry; durable tasks survive restarts via file-backed storage.
3. **Idle-only execution** — Fires are deferred until the agent is idle, preventing interruption of in-progress work.
4. **Multi-session safety** — O_EXCL-based locking ensures exactly one session processes file-backed tasks.
5. **Anti-thundering-herd** ‒ Forward jitter on recurring tasks, backward lead on one-shots, minute-gated to avoid rounding hotspots.
6. **Auto-expiry by default** — Recurring tasks auto-expire after a configurable window (default 7 days) to prevent unbounded session growth.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     pi-loop                                    │
│                                                                                │
│  ┌────────────┐  ┌────────────────────────────────┐  │
│  │  Skill Layer   │  │  Scheduling Engine                │  │
│  │  (parsing,     │  │  (cron, jitter, lock, storage)     │  │
│  │  validation)    │  │                                    │  │
│  └────────────┘  └────────────────────────────────┘  │
│          │                       │                         │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  Fire Routing                                                          │  │
│  │  (idle gate, teammate routing, 'later' priority queue, workload attribution) │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Key Concepts from the Reference Implementation

The `import/` directory contains detailed analysis of the Claude Code `/loop` system that inspires pi-loop:

| Document | What it covers |
|----------|---------------|
| [source-map.md](../import/source-map.md) | Full directory structure of the Claude Code source, mapping every module |
| [loop-architecture.md](../import/loop-architecture.md) | End-to-end `/loop` pipeline: skill registration, parsing, CronCreate, storage, scheduler, fire routing |
| [scheduler-internals.md](../import/scheduler-internals.md) | Deep dive: cron expressions, task lifecycle, jitter, locking, auto-expiry, file format |

## Project Status

This is a **development repository** (`pi-loop-DEV`). The `import/` directory contains reference analysis. The `docs/` directory will contain the pi-loop specification and design documents as they're written.

## Repository Structure

```
pi-loop-DEV/
├── import/          # Reference analysis of Claude Code /loop implementation
│   ├── source-map.md          # Directory structure & module map
│   ├── loop-architecture.md    # End-to-end /loop pipeline documentation
│   └── scheduler-internals.md  # Cron scheduler deep dive
├── docs/            # pi-loop design & specification
│   ├── README.md              # This file
│   └── (more to come)
└── src/             # Implementation (coming soon)
```
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
+-------------------------------------------------------------------+
|                              pi-loop                               |
|                                                                     |
|  +-------------+  +-----------------------------+  +-----------+    |
|  |   Command   |  |   Tools (LLM-callable)     |  | Scheduler |    |
|  |   /loop     |  |   cron_create               |  | Engine     |    |
|  |   /loop-list|  |   cron_delete               |  | (1s tick)  |    |
|  |   /loop-kill|  |   cron_list                 |  |            |    |
|  +-------------+  +-----------------------------+  +-----------+    |
|        |                        |                        |         |
|  +---------------------------------------------------------------+ |
|  |           pi-coding-agent Extension API                      |  |
|  |                                                              |  |
|  |  pi.sendUserMessage()  -> inject prompt on fire             |  |
|  |  pi.appendEntry()      -> persist state across branches     |  |
|  |  pi.on("agent_start") -> track idle state                   |  |
|  |  pi.on("agent_end")   -> drain pending fires                |  |
|  |  ctx.ui.notify()       -> fire notifications                 |  |
|  |  ctx.ui.setStatus()    -> scheduler status indicator          |  |
|  +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+
```

## Target Platform: pi-coding-agent

Pi-loop is designed as an extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (from the `badlogic/pi-mono` monorepo). The extension hooks into the agent via:

- `pi.registerCommand()` for `/loop`, `/loop-list`, `/loop-kill` commands
- `pi.registerTool()` for `cron_create`, `cron_delete`, `cron_list` LLM-callable tools
- `pi.sendUserMessage()` for injecting scheduled prompts when tasks fire
- `pi.on()` events for idle tracking (`agent_start`/`agent_end`)
- `pi.appendEntry()` for session-aware state persistence

See [pi-extension-api.md](../import/pi-extension-api.md) for the full extension API analysis.

## Key Documents

### Reference Analysis (`import/`)

| Document | What it covers |
|----------|---------------|
| [source-map.md](../import/source-map.md) | Full directory structure of the Claude Code source, mapping every module |
| [loop-architecture.md](../import/loop-architecture.md) | End-to-end `/loop` pipeline: skill registration, parsing, CronCreate, storage, scheduler, fire routing |
| [scheduler-internals.md](../import/scheduler-internals.md) | Deep dive: cron expressions, task lifecycle, jitter, locking, auto-expiry, file format |
| [pi-extension-api.md](../import/pi-extension-api.md) | pi-coding-agent extension API: ExtensionAPI, ToolDefinition, events, commands, loading |

### Design Specification (`docs/`)

| Document | What it covers |
|----------|---------------|
| [loop-extension-design.md](loop-extension-design.md) | Full design spec: architecture, modules, types, commands, tools, scheduler, storage, jitter, auto-expiry, feature mapping |

## Project Status

This is a **development repository** (`pi-loop-DEV`). Reference analysis and design specification are complete. Implementation is next.

## Repository Structure

```
pi-loop-DEV/
├── import/                      # Reference analysis
│   ├── source-map.md             # Claude Code source directory map
│   ├── loop-architecture.md      # End-to-end /loop pipeline
│   ├── scheduler-internals.md    # Cron scheduler deep dive
│   └── pi-extension-api.md       # pi-coding-agent extension API analysis
├── docs/                        # Design & specification
│   ├── README.md                 # This file (project vision)
│   └── loop-extension-design.md # Full extension design spec
└── src/                         # Implementation (coming soon)
```
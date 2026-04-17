# @pi-agents/loop

Recurring prompt scheduling and cron job management for [pi-coding-agent](https://github.com/badlogic/pi-mono). Ported from Claude Code's `/loop` system.

## Features

- **`/loop` command** — Fixed interval (`/loop 5m check the deploy`) or dynamic self-pacing (`/loop monitor the build`)
- **Cron tools** — LLM-callable `cron_create`, `cron_delete`, `cron_list` for programmatic scheduling
- **ScheduleWakeup** — `schedule_wakeup` tool for model-driven dynamic pacing (60-3600s delays)
- **Idle gating** — Prompts only fire when the agent is idle, never interrupting in-progress work
- **Durable tasks** — Optionally persist schedules across sessions via `.pi-loop.json`
- **Missed task recovery** — Durable one-shots missed while offline are detected and fired on restart
- **Session resume** — Session-only tasks survive conversation compaction
- **Anti-thundering-herd** — Deterministic jitter (50% of interval, 30-min cap) prevents API load spikes
- **Auto-expiry** — Recurring tasks expire after 7 days by default
- **Config files** — Per-project `.pi-loop.config.json` overrides
- **Debug mode** — Set `PI_LOOP_DEBUG=1` for verbose logging

## Install

```bash
pi install npm:@pi-agents/loop@latest
```

Or add to your pi-agent settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["npm:@pi-agents/loop"]
}
```

## Usage

### Slash Commands

| Command | Description |
|---|---|
| `/loop [interval] <prompt>` | Start a recurring loop (default: dynamic pacing) |
| `/loop-list` | List all active loops |
| `/loop-kill <id>` | Cancel a loop by ID |

**Fixed interval:**
```
/loop 5m check the deploy
/loop check tests every 15m
```

**Dynamic pacing (no interval):**
```
/loop monitor the build
```
The agent executes the prompt immediately, then uses `schedule_wakeup` to self-pace subsequent iterations.

### LLM Tools

The extension registers four tools the LLM can call directly:

| Tool | Description |
|---|---|
| `cron_create` | Schedule a prompt on a 5-field cron expression |
| `cron_delete` | Cancel a scheduled task by ID |
| `cron_list` | List all active scheduled tasks |
| `schedule_wakeup` | Arm a single-shot timer for dynamic self-pacing |

**cron_create parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cron` | string | required | 5-field cron expression in local time |
| `prompt` | string | required | Prompt to enqueue at fire time |
| `recurring` | boolean | true | true = recurring, false = one-shot |
| `durable` | boolean | false | true = persist across sessions |
| `label` | string | optional | Human-readable label |

**schedule_wakeup parameters:**

| Parameter | Type | Description |
|---|---|---|
| `delaySeconds` | number | Seconds until wake-up (clamped to 60-3600) |
| `reason` | string | Why this delay was chosen |
| `prompt` | string | Prompt to fire on wake-up |

### Cron Format

Standard 5-field cron in local time: `minute hour day-of-month month day-of-week`

| Pattern | Meaning |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `0 */2 * * *` | Every 2 hours |
| `30 14 * * *` | Daily at 2:30 PM |
| `0 9 * * 1-5` | Weekdays at 9 AM |

### Durable vs Session Tasks

- **Session tasks** (default) — Live only for the current session. Survive compaction. Lost when the agent exits.
- **Durable tasks** (`durable: true`) — Persisted to `.pi-loop.json`. Restored on next session start. Missed one-shots are recovered and fired.

### Multi-Instance Safety

When multiple pi-agent sessions run in the same directory, a file-based lock (`.pi-loop.json.lock`) ensures only one instance processes durable tasks. Uses PID-based liveness checking to recover from crashed sessions.

## Configuration

Create `.pi-loop.config.json` in your project root to override defaults:

```json
{
  "maxJobs": 50,
  "recurringMaxAgeMs": 604800000,
  "durableFilePath": ".pi-loop.json"
}
```

| Setting | Default | Description |
|---|---|---|
| `maxJobs` | 50 | Maximum concurrent scheduled tasks |
| `recurringMaxAgeMs` | 604800000 (7d) | Auto-expiry for recurring tasks |
| `recurringJitterFrac` | 0.5 | Jitter as fraction of cron gap (50%) |
| `recurringJitterCapMs` | 1800000 (30m) | Maximum jitter delay |
| `checkIntervalMs` | 1000 | Scheduler tick interval |
| `durableFilePath` | `.pi-loop.json` | Durable task file path |

## Development

```bash
npm run build       # Compile TypeScript
npm run test        # Run all tests (unit + integration)
npm run test:unit   # Run unit tests only
npm run test:watch  # Watch mode
```

## License

MIT

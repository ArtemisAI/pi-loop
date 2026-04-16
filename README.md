# @pi-agents/loop

Recurring prompt scheduling and cron job management for [pi-coding-agent](https://github.com/badlogic/pi-mono).

## Features

- **`/loop` command** — Quick recurring prompts: `/loop 5m check the deploy`
- **Cron tools** — LLM-callable `cron_create`, `cron_delete`, `cron_list` for programmatic scheduling
- **Idle gating** — Prompts only fire when the agent is idle, never interrupting in-progress work
- **Durable tasks** — Optionally persist schedules across sessions via `.pi-loop.json`
- **Anti-thundering-herd** — Deterministic jitter prevents multiple tasks from firing simultaneously
- **Auto-expiry** — Recurring tasks expire after 7 days by default

## Install

```bash
npm install @pi-agents/loop
```

Add to your pi-agent settings (`~/.pi/agent/settings.json`):

```json
{
  "extensions": ["npm:@pi-agents/loop"]
}
```

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/loop [interval] <prompt>` | Start a recurring loop (default 10m) |
| `/loop-list` | List all active loops |
| `/loop-kill <id>` | Cancel a loop by ID |

**Examples:**
```
/loop 5m check the deploy
/loop check tests every 15m
/loop-kill a1b2c3d4
```

### LLM Tools

The extension registers three tools the LLM can call directly:

| Tool | Description |
|------|-------------|
| `cron_create` | Schedule a prompt on a 5-field cron expression |
| `cron_delete` | Cancel a scheduled task by ID |
| `cron_list` | List all active scheduled tasks |

### Cron Format

Standard 5-field cron in local time: `minute hour day-of-month month day-of-week`

| Pattern | Meaning |
|---------|---------|
| `*/5 * * * *` | Every 5 minutes |
| `0 */2 * * *` | Every 2 hours |
| `30 14 * * *` | Daily at 2:30 PM |
| `0 9 * * 1-5` | Weekdays at 9 AM |

### Durable vs Session Tasks

- **Session tasks** (default) — Live only for the current session. Lost when the agent exits.
- **Durable tasks** (`durable: true`) — Persisted to `.pi-loop.json` and restored on next session start.

## Configuration

Default configuration in `config/default.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxJobs` | 50 | Maximum concurrent scheduled tasks |
| `recurringMaxAgeDays` | 7 | Auto-expiry for recurring tasks |
| `recurringJitterFrac` | 0.1 | Jitter as fraction of cron gap |
| `recurringJitterCapMinutes` | 15 | Maximum jitter cap |
| `checkIntervalMs` | 1000 | Scheduler tick interval |

## Development

```bash
npm run build    # Compile TypeScript
npm run lint     # Type-check without emitting
npm run dev      # Run with pi-agent in dev mode
```

## License

MIT

---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)
---

## When to use

Use this skill when the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval.

Examples:
- "check the deploy every 5 minutes"
- "keep running tests every 15m"
- "remind me at 2:30pm to review PRs"
- "keep iterating on the refactor"

## Tools

| Tool | Purpose | Context cost |
|------|---------|-------------|
| `cron_create` | Schedule a prompt on a cron schedule (recurring or one-shot) | Low |
| `cron_delete` | Cancel a scheduled task by ID | Low |
| `cron_list` | List all active scheduled tasks | Low |

## Preferred order

1. Use `cron_list` to check existing schedules before creating duplicates
2. Use `cron_create` to schedule new tasks
3. Use `cron_delete` to cancel tasks that are no longer needed

## Slash commands

- `/loop [interval] <prompt>` — Quick recurring loop (e.g. `/loop 5m check the deploy`)
- `/loop-list` — List all active loops
- `/loop-kill <id>` — Cancel a loop by ID

## Cron format

5-field cron in local time: `minute hour day-of-month month day-of-week`

| Pattern | Meaning |
|---------|---------|
| `*/5 * * * *` | Every 5 minutes |
| `0 */2 * * *` | Every 2 hours |
| `30 14 * * *` | Daily at 2:30 PM |
| `0 9 * * 1-5` | Weekdays at 9 AM |

## Notes

- Loops only fire when the agent is idle (not streaming)
- Recurring tasks auto-expire after 7 days
- Use `durable: true` to persist tasks across sessions
- Session-only tasks (default) are lost when the agent exits

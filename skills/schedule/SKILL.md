---
name: schedule
description: Create, list, and manage scheduled cron tasks that fire prompts at specific times or intervals
---

## When to use

Use this skill when:
- The user wants to schedule something for a specific future time
- The user wants to set up a one-shot reminder
- You need to programmatically schedule your own follow-up work
- The user asks about existing scheduled tasks

## Tools

| Tool | Purpose | Context cost |
|------|---------|-------------|
| `cron_create` | Schedule a prompt (recurring or one-shot) | Low |
| `cron_list` | List active scheduled tasks | Low |
| `cron_delete` | Cancel a task by ID | Low |

## Preferred order

1. `cron_list` — check what's already scheduled
2. `cron_create` — create the new task
3. `cron_delete` — clean up when done

## Examples

```
"Remind me at 3pm to push the branch"
→ cron_create { cron: "0 15 * * *", prompt: "Reminder: push the branch", recurring: false }

"Check the CI pipeline every 10 minutes"
→ cron_create { cron: "*/10 * * * *", prompt: "Check CI pipeline status", recurring: true }

"What's scheduled right now?"
→ cron_list {}

"Stop the deploy monitor"
→ cron_list {}, then cron_delete { id: "<id>" }
```

---
name: schedule-followup
description: Schedule a future check-in that creates a WorkItem for you or another agent at a specific time (one-shot or bounded recurring).
version: 1.0.0
category: followup
skillType: claude-skill
tags:
  - followup
  - schedule
  - cron
  - workitem
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# schedule-followup

Schedule a future check-in that creates a WorkItem for you or another agent.
Use this when you need to **come back to something at a specific time** — most
commonly to chase a response, verify an async result, or re-prompt an agent
that went quiet.

## When to use this vs other scheduling skills

| Need | Use |
|------|-----|
| "Wake me up in 30 min to check X" (self) | `schedule-followup --in-minutes 30 --title "Check X"` |
| "Check back on another agent at 9am" | `schedule-followup --fire-at 2026-04-24T09:00:00Z --target agent-session --title "..."` |
| "Hourly for up to 3 tries, then give up" | `schedule-followup --cron "0 * * * *" --max-fires 3` |
| "Whenever Rex goes idle, check progress" | `watch-for-event` (event-based, not this skill) |
| Simple self-reminder with no team scope | `schedule-check` (older skill) |

## Before you schedule — check you aren't already scheduled

Schedules live in **two stores**: follow-up triggers (this skill) and cron
tasks the orchestrator sets for you. Check **both** before creating, or you
will stack a duplicate that fires N× reports:

- `list-my-followups` — your follow-up triggers
- `list-my-crons` — recurring crons targeting you (the orchestrator's)

Do **not** treat "cron list shows 0" alone as "no schedule exists" — verify
with both skills, and if still unsure, ask the orchestrator instead of
re-creating (#621).

## Key invariants

- Every followup is **team-scoped**. It shows up under `list-my-followups` and
  can be cancelled by `name` via `cancel-followup`.
- Every followup has a **finite lifetime**: either `maxFires` exhausts it, or
  `maxIdleFires` (default 3) auto-cancels it after consecutive unproductive
  fires.
- If you forget to cancel a done followup, it will still terminate itself.
  That's by design — we refuse to let followups live forever.

## Examples

```bash
# One-shot self-reminder 30 minutes from now
bash execute.sh --in-minutes 30 --title "Verify Rex delivered the draft"

# One-shot absolute time, targeting Ella
bash execute.sh --fire-at 2026-04-24T09:00:00Z \
  --target crewly-marketing-ella-member-1 \
  --title "Re-prompt Rex if no response yet"

# Recurring with cap — will auto-stop after 3 tries even if you forget to cancel
bash execute.sh --cron "0 * * * *" --max-fires 3 \
  --title "Poll Rex hourly (give up after 3)"
```

## Output

On success, returns the created `Trigger` object (JSON with `id`, `status`,
`nextFireAt`, etc). Keep the `id` or `name` if you may need to cancel later.

## Cancelling

- By id: `cancel-followup --id <trigger-id>`
- By name: `cancel-followup --name "followup:abc123"`
- Or let `maxFires`/`maxIdleFires` do it automatically.

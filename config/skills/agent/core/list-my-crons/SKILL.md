---
name: list-my-crons
description: List the recurring cron tasks the orchestrator has scheduled FOR you — call before self-scheduling so you don't create duplicates that fire N× reports.
version: 1.0.0
category: followup
skillType: claude-skill
tags:
  - cron
  - schedule
  - audit
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# list-my-crons

List the recurring **cron tasks** that target you — i.e. schedules the
orchestrator (or you) registered with you as the `targetAgent`. Call this
**before** creating a cron or a `schedule-followup`, so you can confirm whether
you are already scheduled instead of stacking a duplicate.

## Why this exists

Cron tasks and follow-up triggers live in **two different stores**:

| What | Store | List it with |
|------|-------|--------------|
| Recurring cron the orchestrator set for you | cron-tasks (per-team file) | **`list-my-crons`** (this skill) |
| Follow-up timers you created | triggers (TriggerEngine) | `list-my-followups` |

`list-my-followups` will **not** show the orchestrator's crons — they are in a
separate store. If you only check followups, you can wrongly conclude "I have
no schedule" and self-create a duplicate cron. That duplicate then fires every
trigger N× (N identical reports/PDFs). Always check **both** before scheduling.

> Note: "cron API shows 0" is **not** a reliable "no schedule exists" signal on
> its own — historically agents misread it and self-duplicated (#621). Check
> the actual list here, and if unsure, ask the orchestrator rather than
> re-creating.

## Examples

```bash
# All crons targeting you
bash execute.sh

# Only enabled ones
bash execute.sh --enabled true
```

## Options

| Flag | Meaning |
|------|---------|
| `--enabled <true\|false>` | Filter by enabled state (optional) |
| `--target <session>` | Query a different agent's crons (default: yourself) |
| `--json`, `-j` | Raw JSON payload (legacy) |

## Output

```
{ "success": true, "count": <n>, "data": [ CronTask, ... ] }
```

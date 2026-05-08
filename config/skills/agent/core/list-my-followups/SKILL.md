---
name: list-my-followups
description: List every follow-up trigger owned by your team — call before creating a new watcher to avoid duplicates, or when auditing why something keeps firing.
version: 1.0.0
category: followup
skillType: claude-skill
tags:
  - followup
  - trigger
  - audit
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# list-my-followups

List every follow-up trigger owned by your team. Call this **before** creating
a new watcher to avoid stacking duplicates, or when auditing why something
keeps firing.

## Examples

```bash
# Everything your team has
bash execute.sh

# Only the still-firing ones
bash execute.sh --status active

# Just the agent:idle watchers (by name convention)
bash execute.sh --name-prefix watch:
```

## What you see

Returns `{ success, count, data: [Trigger, ...] }`. Each `Trigger` includes:
- `id`, `name`, `status`
- `config` (cron expression / fireAt / event type)
- `action` (what it creates when it fires)
- `fireCount`, `nextFireAt`, `lastFiredAt`, `maxFires`, `maxIdleFires`

## Audit patterns

- **Firing too often?** Look at `consecutiveIdleFires` — if it's high, the
  watcher is producing no-op WorkItems and should be narrowed or cancelled.
- **Duplicates?** Same `name` across multiple results means the dedup by
  `(createdBy, name)` in the engine rejected the newer attempts — the
  existing one is already in force.
- **Stale?** `nextFireAt` in the past for a `time` trigger means the engine
  poll hasn't caught up yet; give it 60s.

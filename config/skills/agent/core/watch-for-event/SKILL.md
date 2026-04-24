# watch-for-event

Subscribe to a system event (like `agent:idle` or `task:completed`) and create
a WorkItem for yourself or another agent every time it fires. Use this when
your follow-up should be **reactive to what Rex/the system does**, not tied to
a wall-clock time.

## When to use this vs `schedule-followup`

| Need | Use |
|------|-----|
| "Whenever Rex goes idle, check progress" | `watch-for-event --event-type agent:idle --filter-session rex-session` |
| "Alert me when any task completes" | `watch-for-event --event-type task:completed` |
| "Poll at 9am tomorrow" | `schedule-followup --fire-at ...` (time, not event) |
| "Check every hour up to 3 times" | `schedule-followup --cron "0 * * * *" --max-fires 3` |

## Common event types

| Event | When it fires |
|-------|---------------|
| `agent:idle` | An agent's `workingStatus` flipped to `idle` |
| `agent:active` | An agent started working |
| `agent:inactive` | An agent stopped heartbeating |
| `task:completed` | A task was marked done |
| `task:failed` | A task failed |

See `types/event-bus.types.ts` for the authoritative list.

## Filtering

By default the watcher fires on **every** occurrence of the event type. Narrow
it with `--filter-session` (most common) to only fire for one specific agent,
or `--filter-json` for arbitrary payload matching.

```bash
# Only when THIS agent goes idle
bash execute.sh --event-type agent:idle \
  --filter-session crewly-marketing-rex-member-1 \
  --title "Rex idle — verify Rex task"

# Match a richer filter shape
bash execute.sh --event-type task:completed \
  --filter-json '{"missionId":"q2-growth"}' \
  --title "Q2 mission task landed"
```

## Key invariants

- Every watcher is **team-scoped**, listed under `list-my-followups`,
  cancellable by `name` via `cancel-followup`.
- **No implicit upper bound on fires**: if you set `--max-fires`, great.
  Otherwise rely on `--max-idle-fires` (default 3) to auto-cancel once the
  watcher stops producing useful work.
- A watcher that fires 20× in a minute because an agent is flapping is YOUR
  responsibility to handle (either narrower filter, or cap with max-fires).

## Cancelling

- Explicit: `cancel-followup --id <trigger-id>` or `--name <name>`
- Automatic: `maxFires` exhausts, or `maxIdleFires` trips.

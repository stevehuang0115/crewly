# A block with `until` is a planned wait (CREW-893)

Follow-up to `2026-10-27-block-task-until.md`. The 2026-10-26 CE retro listed
"no 'waiting until <time>' state: scheduled readouts must go blocked, counted
as stalls and stopping autopilot". The state shipped in 1.20.466; this closes
what was left of the complaint.

## What was still wrong

1. `task:blocked` → the event bridge created a `:review:blocked` WorkItem for
   the team lead ("TL must unblock or re-scope") even when the block had an
   `until` time. CE-316 on 2026-10-27: Owen was woken at 08:35Z to review a
   block that lifts itself at 14:05Z.
2. Trace metrics (`computeTraceMetrics`) opened an agent hold for every
   non-closed work item status, `blocked` included, and every quiet period
   longer than the stall threshold is a stall. A three-hour planned wait was
   three hours of `waiting_on_agent` in the daily retro and the autopilot
   stats.

The autopilot's own stop rule (`findStalledWork`) already ignores blocked
items (only `queued`/`accepted`/`running`/`scheduled` are live), so the
"stopping autopilot" part of the complaint dates from before `until` existed
(the holder kept the item `running`). Nothing to change there.

## Change

- `traceWorkItemStatus` puts `blockedUntil` (ISO) in the `workitem.status`
  event's data, and `until …` in its summary, when the item is blocked with a
  parsable until time.
- `collectHolds` records a planned wait `[blockedAt, min(until, next status
  change)]` for such an event instead of an agent hold. The main loop adds
  planned waits to the covered intervals, so no stall gap opens inside one.
  An item still blocked past its `until` holds its agent from that time
  ("Work item for X is still blocked past its until time") and stalls as
  before.
- `handleTaskBlocked` (event bridge) returns without a review WorkItem when
  `blockedUntilOf(sourceWI)` is set, logging "Blocked until a known time — no
  review for the lead".

## Not changed

- A block without `until` is unchanged everywhere: lead review, agent hold,
  stall.
- `scheduled` items were already outside agent holds
  (`WORK_ITEM_WAITING_ON_TIME`); their quiet time still counts as a stall
  (`nobody_pushing`) because the trace carries no schedule time. Out of
  scope here.
- The ticket-autopilot stats reuse `computeTraceMetrics`, so the retro's
  "Stalls" line follows without its own change.

## Tests

- `trace-recorder.test.ts`: `blockedUntil` on the event, none for an
  unparsable value.
- `trace-metrics.test.ts`: planned wait → no stall; blocked past until →
  `waiting_on_agent` from the until time; open-ended block unchanged.
- `event-to-workitem-bridge.service.test.ts`: no review for a block with
  `until`.

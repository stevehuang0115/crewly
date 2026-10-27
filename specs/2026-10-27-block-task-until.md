# block-task `until`: parking work until a known time

**Date:** 2026-10-27
**Status:** Implemented

## Problem

An agent whose task can only proceed at a known time (CE-433: a GA4 readout
that needs the full 7-day window and runs from an 08:30Z timer) had no way to
say so. The observed chain on 2026-10-27:

1. The agent reported the item done by mistake → the lead rejected it ("Not
   delivered … runs from her 08:30Z timer") → retry 1.
2. The agent held the retry `running` while waiting → the idle-holder review
   went to the lead.
3. The agent completed it again at 03:02 → rejected → retry 2 (of 3).
4. The agent was stopped under memory pressure, woken, and wrote a progress
   note "waiting for 7-day window, runs 08:30Z".

`block-task` had no time parameter, and an explicit block stays blocked until
someone releases it. `scheduled`/`scheduledAt` exists only for queued items
(trigger-created); nothing could park a running item until a time.

## Change

- `TaskPoolService.blockItem(id, { agentId, reason, until? })` stores `until`
  (ISO 8601) at `metadata.blockedUntil`; an unparsable value throws. A later
  block without `until` drops an earlier one. `releaseBack` drops the key.
- `POST /api/task-pool/block/:workItemId` accepts `until`; 400 when it does not
  parse or is not in the future. `GiveUpRecoveryService.block` passes it through.
- Types: `WORK_ITEM_BLOCKED_UNTIL_KEY`, `blockedUntilOf(wi)`,
  `isBlockedUntilReached(wi, now)` (explicit block + time not in the future).
- Reconciler full pass, step 3c-ii: `detectDueBlockedWorkItems` emits
  `blocked → queued` for due blocks with `blockSource: 'explicit'`; the apply
  path passes `allowExplicitWhenDue: true` only for that marker, and
  `requeueWorkItem` lifts an explicit block only when both the flag is set and
  the time has in fact passed (reason `blocked_until_reached`). Every other
  explicit-block requeue is still refused. `releaseBack` keeps `target`, so the
  item returns to the same agent, who takes it before new work (the hybrid wake
  dispatches it even when the agent is asleep, #1530). Resolution: the full
  pass interval, 60 s.
- Skills: `block-task` `until` parameter + guidance (SKILL.md 1.1.0, execute.sh
  passes it through); `complete-task` SKILL.md: a task waiting for a known time
  is blocked with `until`, not completed.

## Not changed

- `blocked` is still entered only from `running`; a dispatched-but-unclaimed
  item cannot be parked (claim it first).
- A past `until` is refused at the API; the service accepts any parsable time
  (tests rely on it; the reconciler lifts it on the next pass).
- `scheduled`/`scheduledAt` for queued items is untouched.

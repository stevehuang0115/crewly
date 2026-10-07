# Ticket autopilot: goal replan when nothing is left to triage

Issue: #1033. Builds on specs/2026-09-30-ticket-autopilot.md and
specs/2026-10-03-autopilot-experiments.md.

> **Superseded in part by specs/2026-10-04-autopilot-speed-modes.md (#1077):**
> the daily replan cap and the gap between replans now come from the
> project's speed mode (Normal: ≤ 4 a day, ≥ 3 h apart), and the wait after
> an empty replan is the mode's retry (Rush 1 h, Normal the next day, Chill
> the next week) instead of 2 / 4 / 7 days. `replansPerDay` (now 0–12) still
> overrides the mode's cap.

## Problem

The autopilot wakes the project's driver only when there are tickets to
triage. When a project has a goal but its backlog is empty, every evaluation
ends in `nothing_to_triage` and nobody plans the next step. A goal-driven team
stops as soon as its current tickets are done.

CE, 2026-10-03: the goal (1,000 /feed visitors a week, 25% returning) was in
the project goals and the autopilot was on (driver Owen, 50M tokens/day). The
team shipped the feed publicly at ~19:51Z (CE-107). After that, no feed ticket
was open: CE-39 and CE-54 are parked backlog items unrelated to the goal. All
three members sat idle, and CE-101's own plan ("at least 1 new feed card per
day") was not being carried out. The owner noticed it himself, which is
exactly the owner attention the autopilot exists to save.

## Change

A sibling of `decideTriage`: `decideReplan` (pure, in
`ticket-autopilot-decision.ts`). When it says `replan`, the autopilot wakes the
driver with ONE `goal_replan` WorkItem asking it to open the next tickets
toward the goal, or say why there are none.

### When (checked in order; the first that fails is the skip reason)

The cheap gates come first: they use in-memory state only. The goal is the
only gate that reads files, and it is checked last (review of #1041).

| # | Check | Skip reason |
|---|---|---|
| 1 | Autopilot is on | `off` |
| 2 | The project has a driver | `no_driver` |
| 3 | Replans are allowed (`replansPerDay` > 0) | `replan_off` |
| 4 | Under today's token budget (boosts included) | `budget_reached` |
| 5 | No triage item of the project is live | `triage_in_flight` |
| 6 | No replan item of the project is live (and not expired) | `replan_in_flight` |
| 7 | Zero triage candidates | `tickets_to_triage` |
| 8 | At least one member is idle | `nobody_idle` |
| 9 | An idle member is under the in-progress cap (`maxInFlightPerMember`) | `at_capacity` |
| 10 | Fewer than `replansPerDay` replans today (local day) that opened no tickets, and fewer than `REPLAN_HARD_CEILING_PER_DAY` (16) replans in all (CREW-265: a replan that opened tickets does not count toward the cap) | `replanned_today` |
| 11 | Not backing off after empty replans (see Backoff) | `backed_off` |
| 12 | The project has an active goal (reads goals.md and the missions) | `no_goal` |

The service only looks at replanning after `decideTriage` skipped with
`nothing_to_triage`, so every other triage outcome is unchanged. A project with
no goal never gets a replan WorkItem: the triage decision and its
`nothing_to_triage` trace are the same as before. The evaluation result may
carry a cheap-gate skip reason in its `replan` field (for example
`nobody_idle`), because the goal is only read once those gates pass.

"Live" uses the triage meaning: queued, scheduled, proposed, accepted, running,
blocked, escalated or done_by_worker.

### TTL and triage yield (review of #1041)

- **TTL.** A replan that is still live after `replanTtlHours` (default 4, from
  1 to 48) is expired, in any live state:
  - queued, blocked or scheduled: `cancelQueued`;
  - running: release the claim, then `cancelled` (as system);
  - proposed, accepted or escalated: `cancelled` (as system);
  - done_by_worker: the pool does not allow cancelling it (only its reviewer
    can give a verdict), so it is left as it is but no longer counted as live.

  If the pool refuses the cancel, the item still stops counting as live. A
  replan can therefore never hold triage for longer than its TTL.
- **Triage yield.** While a replan is live, triage waits (`replan_in_flight`),
  so the driver isn't sent a triage of tickets it is opening in the same turn.
  Once there are triage candidates and the replan is older than
  `REPLAN_YIELD_AFTER_MS` (1h), the hold yields and the new tickets are
  triaged.

### Backoff (review of #1041: no daily drip once the goal is met)

`goals.md` is append-only, so any goal would otherwise wake the driver every
idle day, even after it is met. Two rules prevent that:

- **Active window.** Only goals-log entries from the last
  `REPLAN_GOAL_ACTIVE_DAYS` (30) days count as an active goal. An entry
  without a readable date, or a file without entry headers, is judged by the
  file's modification time. OKRs keep their own status (active, approved).
- **Backoff after an empty replan.** When the last replan is no longer live
  (finished, cancelled or expired), the next evaluation checks it once:
  - If a ticket was created since it was queued, it opened tickets, and the
    backoff and its streak are cleared.
  - If not ("there are none"), the streak goes up by one and replans are
    skipped for the next 2 days, then 4, then 7 (doubling, capped at
    `REPLAN_BACKOFF_MAX_DAYS`), counted from the replan's day.
  - When the skipped days are over, replans may run again, but the streak is
    kept, so the next empty replan backs off longer.
  - **Reset:** a ticket created after the backoff started, or a goal or OKR
    change after it started, lifts the backoff and clears the streak. A goal
    change is detected from file times only, without reading the files: the
    mtimes of goals.md and of the project's and the shared missions folders.
    A change to another project's mission in the shared store only lifts a
    backoff early; it never makes one last longer.
- Status shows `replanBackoffUntil`.

### Accepted as is (review of #1041)

- **Counted when queued.** A replan counts toward today's limit as soon as
  it is queued, even if it is later cancelled or expires without running.
- **Calendar-day cap.** The limit is per local calendar day, not a rolling 24
  hours: a replan at 23:50 and another at 00:10 are both allowed.

### Settings

- `Project.ticketAutopilot.replansPerDay`: a whole number from 0 to
  `REPLANS_PER_DAY_LIMIT` (5). The default is `DEFAULT_REPLANS_PER_DAY` (1),
  and 0 turns replanning off.
- `Project.ticketAutopilot.replanTtlHours`: 1 to 48, default 4.

Only the owner or the orchestrator can change them:

- API: `POST /api/project-ticket-autopilot/:project {replansPerDay,
  replanTtlHours}`. `null` resets a field to its default.
- Skill: `autopilot --replans-per-day <n|default> --replan-ttl-hours
  <n|default>`.

### Goal source

The service takes an injected `goalOf(project, now)`, plus `goalChangedAt(project)`, which returns file times only and is used for the backoff reset. Without it, there is no goal
and replanning never runs, which is how the existing tests behave. In
production it reads both of these:

1. The project's goals log, `<project>/.crewly/goals/goals.md` (written by
   `set_goal`, read by `get_goals` and by the mission card). Entries from the
   last 30 days are used, newest first, capped at `REPLAN_GOAL_MAX_CHARS`. A file
   with only the `# Project Goals` header, or no file, means no goal.
2. Active project OKRs: missions with `status: active`, a `projectId` equal to
   the project's id and approval absent or approved. These come from the
   project's missions folder and the shared store. The objective and success
   criteria are included.

Either source is enough to count as an active goal.

### The WorkItem

- `type` and `metadata.kind`: `goal_replan`
- `owner: team_lead`, `target`: the driver, `targetSource: assigned`
- `metadata`: `{projectId, projectPath, teamId, requiresVerification: false,
  trigger, goalSources, closedTicketIds, experimentIds}`
- Title: `Plan next tickets toward the goal: <project>`
- The brief contains:
  - the goal text;
  - the tickets closed (done or cancelled) in the last
    `REPLAN_CLOSED_LOOKBACK_DAYS` (7) days, newest first, capped at 20;
  - any open experiment card (status planned or running) whose autopilot scope
    is this project or whose ticket link names it;
  - the team, with availability and in-progress counts, as in the triage brief;
  - the ask: "Open the next tickets toward this goal, or say why there are
    none."

### Boundary

The boundary is unchanged. The brief tells the driver to create tickets (in
the backlog, or ready if it would make them ready in a triage). The autopilot
never makes a ticket ready and never starts work. The same owner-OK
boundaries (outside messages, publishing, production deploys, spending) are
repeated in the brief.

### Trace and stats

- Each replan records an `autopilot.action` event with `action: replan` in the
  day's run trace. It starts the run trace if there isn't one, because a
  replan is autopilot work. It also goes in the replan turn's own trace
  (`kind: triage`, summary `Goal replan: …`), so the driver's turn stays out of
  the run trace's event cap.
- The stats count `replans` per day and in total (the number of `replan`
  events in run traces). A replan is not an owner touch.
- The retro counts a day that only had a replan as autopilot work.
- `GET …/autopilot` status adds `replanInFlight`, `replansToday` and
  `lastReplanAt`.
- All text the harness writes is in English.

## Tests

- `decideReplan`: one test per skip reason, and the happy path.
- `decideTriage`: `replan_in_flight`.
- Service:
  - A project with no goal: the decision and the trace are identical to
    today, and no replan is created.
  - A project with a goal, an empty backlog and an idle member: one
    `goal_replan` for the driver, with the goal, the closed tickets, the open
    experiment and the ask in the brief.
  - A second idle event the same day does nothing (`replanned_today`), even
    after the first one is done. The next day it replans again.
  - A live replan blocks a second replan and holds triage.
  - The budget and the in-progress cap are respected.
  - Run trace: there is a `replan` event, and the stats count `replans` and
    no owner touch.
- Settings: `replansPerDay` and `replanTtlHours` validation and reset.
- Review fixes:
  - TTL expiry of a running replan (cancelled) and of a done_by_worker one
    (left as is, no longer live), with a configurable TTL;
  - triage yields to waiting tickets after 1h;
  - backoff of 2, 4 and 7 days, lifted by a new ticket and by a goal change;
  - the goal is not read on cheap-gate skips;
  - the 30-day goals-log window.
- Goal reader: parsing goals.md and filtering missions.

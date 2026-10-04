# Ticket autopilot: goal replan when nothing is left to triage

Issue: #1033. Builds on specs/2026-09-30-ticket-autopilot.md and
specs/2026-10-03-autopilot-experiments.md.

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

| # | Check | Skip reason |
|---|---|---|
| 1 | Autopilot is on | `off` |
| 2 | The project has a driver | `no_driver` |
| 3 | The project has an active goal | `no_goal` |
| 4 | Replans are allowed (`replansPerDay` > 0) | `replan_off` |
| 5 | Under today's token budget (boosts included) | `budget_reached` |
| 6 | No triage item of the project is live | `triage_in_flight` |
| 7 | No replan item of the project is live | `replan_in_flight` |
| 8 | Zero triage candidates | `tickets_to_triage` |
| 9 | At least one member is idle | `nobody_idle` |
| 10 | An idle member is under the in-progress cap (`maxInFlightPerMember`) | `at_capacity` |
| 11 | Fewer than `replansPerDay` replans today (local day) | `replanned_today` |

The service only looks at replanning after `decideTriage` skipped with
`nothing_to_triage`. That means the goal is read only then, and every other
triage outcome is unchanged. A project with no goal behaves exactly as today:
the triage skip `nothing_to_triage` is returned and traced the same way, and no
replan is created.

"Live" uses the triage meaning: queued, scheduled, proposed, accepted, running,
blocked, escalated or done_by_worker. A replan item still queued after
`TRIAGE_STALE_QUEUED_MS` is cancelled, like a stale triage. A cancelled one
still counts toward today's limit.

While a replan is live, triage also waits (new skip reason
`replan_in_flight`). Otherwise the driver would be sent a triage of tickets it
is opening in the same turn.

### Settings

`Project.ticketAutopilot.replansPerDay`: a whole number from 0 to
`REPLANS_PER_DAY_LIMIT` (5). The default is `DEFAULT_REPLANS_PER_DAY` (1), and
0 turns replanning off. Only the owner or the orchestrator can change it:

- API: `POST /api/project-ticket-autopilot/:project {replansPerDay}`. `null`
  resets it to the default.
- Skill: `autopilot --replans-per-day <n|default>`.

### Goal source

The service takes an injected `goalOf(project)`. Without it, there is no goal
and replanning never runs, which is how the existing tests behave. In
production it reads both of these:

1. The project's goals log, `<project>/.crewly/goals/goals.md` (written by
   `set_goal`, read by `get_goals` and by the mission card). The newest
   entries are used, newest first, capped at `REPLAN_GOAL_MAX_CHARS`. A file
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
- Settings: `replansPerDay` validation and reset.
- Goal reader: parsing goals.md and filtering missions.

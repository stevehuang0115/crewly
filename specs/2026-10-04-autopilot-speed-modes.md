# Ticket autopilot: speed modes, metric-linked replans, self-review, stop reasons

Issue: #1077. Builds on specs/2026-09-30-ticket-autopilot.md,
specs/2026-10-03-autopilot-experiments.md and
specs/2026-10-04-autopilot-goal-replan.md (whose replan cap and backoff this
replaces).

## Problem

CE, 2026-10-03/04: the project's only goal replan of the day ran at 00:06
(`DEFAULT_REPLANS_PER_DAY: 1`). Once the tickets it opened were done the
backlog drained and the team stopped for the rest of the day (new tickets per
day 32 → 23 → 13 → 5; nothing after 8 pm ET). An empty replan backed off 2–7
days. Only about a quarter of 111 tickets were tied to a goal metric, and
nothing said *why* the autopilot had stopped.

## 1. Speed modes (per project)

`Project.ticketAutopilot.speedMode`: `rush | normal | chill`. Absent = Normal
(every project before this change). Defaults (owner approved), in
`TICKET_AUTOPILOT_CONSTANTS.SPEED_MODES`:

| | Rush | Normal | Chill |
|---|---|---|---|
| Replan min gap (`replanMinGapMs`), only while the last replan's work is in flight (see Replan trigger) | 1 h | 3 h | none |
| Replan hard cap per local day (`replansPerDayCap`) | 12 | 4 | 1 |
| Self-review cadence (`selfReviewEveryMs`) | hourly | daily (24 h) | weekly (7 d) |
| After an empty replan (`emptyReplanRetry`) | retry 1 h later | next local day | 7 local days later |
| Daily budget when none is set | 50M tokens | 20M (the old default) | 8M |

Explicit settings win:

- Budgets are in cost-weighted budget tokens (crewly#1090, specs/2026-10-02-spend-cap.md §1): the 50M / 20M / 8M figures below are not raw token counts any more; the same numbers last about 7x longer on a cache-heavy team.
- `dailyBudgetTokens` (and usage boosts) over the mode's budget. CE keeps its
  explicit 50M whatever the mode. `budgetSource: 'explicit' | 'mode'`.
- `replansPerDay` (now 0–12, `REPLANS_PER_DAY_LIMIT`) over the mode's cap.
  `replansPerDaySource: 'explicit' | 'mode'`.

`resolveTicketAutopilotSettings` returns the mode and its resolved values;
`applyTicketAutopilotInput` accepts `speedMode` (any case; `null` / `default`
resets to Normal).

### Replan trigger

Unchanged trigger ("nothing left to triage + someone idle with room", from a
tick or a member going idle). `decideReplan` gains one gate after the daily
cap: `replan_too_soon` while `now − lastReplanAt < replanMinGapMs` (the gap
counts across midnight). The daily cap stays as the safety brake.

**The gap only applies while the previous replan's work is still in flight.**
When the project is *idle and empty* — nothing to triage, no ready or
in-progress ticket (parked / deferred / skip-labelled tickets are not work),
and every non-paused member idle — the mode's gap is dropped and the replan
runs at once (CE, 2026-10-05: all tickets done by 04:08Z, the autopilot sat idle
until the 3 h gap allowed 05:32Z). Still respected: the daily cap, the budget
brake, the empty-replan retry (a replan that opened nothing waits its retry),
paused teams, a live triage / replan, and a debounce of
`IDLE_REPLAN_DEBOUNCE_MS` (10 min, `min(gap, 10 min)` so Chill's no-gap stays
no-gap) since the last replan, so it cannot loop. `effectiveReplanGapMs`
(pure) picks the gap.

### Empty-replan retry

`nextReplanBackoff(…, retry)` stores `resumeAt` (epoch ms) as well as
`resumeDay`: hours → `now + amount h`; days → local midnight `amount` days
after the replan's day. `replanBackoffState` uses `resumeAt` when present
(backoffs stored before this change keep using `resumeDay`). A new ticket or a
goal / OKR change still lifts it. The streak is kept for the log only; the
wait no longer doubles.

Switching mode re-times a backoff that still holds to the new mode's retry
from when it started (switching Normal → Rush does not wait for tomorrow).

## 2. Metric-linked replan tickets

- The replan brief requires each new ticket to name the goal metric it moves
  and the expected effect: `create … --metric "<goal metric> → <expected
  effect>"`. The brief also quotes the driver's latest self-review (its next
  bet drives the replan).
- `ProjectTicketWorkflowService.create` accepts `metric` (≤ 300 chars) and
  writes it as the description's first line: `Metric: <metric>`.
- The autopilot policy gains `checkCreate(project, caller, input)`. A ticket is
  checked only when the caller is the target session of a **live goal replan**
  of that project (live status, within its TTL) and the autopilot is on. The
  owner, the orchestrator, other members and tickets created outside a replan
  are never checked. A ticket without a metric reference (`--metric`, or a
  `Metric:` line of ≥ 5 chars in the description) is refused with HTTP 400 and
  a message telling the agent exactly how to fix it (`replanMetricRejection`);
  the refusal is traced (`replan_ticket_rejected`). Nothing is dropped silently.

## 3. Self-review

At the mode's cadence the driver gets ONE short `autopilot_self_review`
WorkItem (type and `metadata.kind`): the goal (≤ 800 chars), counts since the
last review (closed, ready, in progress, backlog, waiting on the owner), the
current stop reason, the last next bet, and the command:

```
execute.sh self-review --project P --gap "…" [--moved "…"] --next-bet "…"
```

`decideSelfReview` (pure): off → no driver → over budget → not due → one live
already → **skipped when nothing changed since the last one and nobody is
idle**. "Changed" = a ticket updated after the last ask, the stop reason
changed, or the goal / OKRs changed (file times). Never for a paused team (the
driver comes from non-paused teams only) and never over the budget brake.
Projects without a goal get none. A self-review still live after 2 h stops
holding the next one (a queued one is cancelled).

`POST /api/project-ticket-autopilot/:project/self-review {gap, moved?, nextBet}`
(owner / orchestrator / project lead) stores it on the project's autopilot
state (last 10), traces `self_review_filed`, and it appears in the status
(`lastSelfReview`, `nextSelfReviewAt`), the evening digest (if from the last
24 h) and the next replan brief.

## 4. Stop reasons

`classifyStopReason` (pure), most decisive first:

1. `paused` — every team on the project is paused (#1070);
2. `budget_reached` — today's budget (with boosts) is used up;
3. `system_error` — an autopilot WorkItem (triage / replan / self-review)
   queued ≥ 1 h while its target sits idle (the wake never landed), or (when
   nothing is moving) a project WorkItem that failed in the last 6 h;
3a. `stalled_work` — an in-progress ticket whose assignee is registered
   (`active`) and idle, with its WorkItem still live and no ticket / WorkItem
   change for the mode's `stallAfterMs` (rush 10 min, normal 20, chill 60).
   "In progress" only counts as running while someone is on it (§4a);
4. *(running — tickets in progress or ready, tickets to triage, or a live
   triage / replan: no reason)*;
5. `waiting_on_owner` — open tickets in review / `needs-owner` / `retro-pending`;
6. `no_ideas` — the last goal replan opened nothing and its retry has not come;
7. `daily_replan_cap` — today's replans are used up (status and digest give the
   next local midnight as the time it may run again);
8. `waiting_for_replan` — the gap (work in flight) or the debounce has not
   passed since the last replan; status (`stopUntil`) and the digest say when
   it may run next ("waiting for the next goal replan (may run at …)").

An idle autopilot therefore always says why; a stopped project with no reason
is one that has never replanned yet.

Stopped for none of these has no reason. Each tick
classifies every enabled project; a change is traced in the run trace
(`stopped` with the reason, `resumed` when it moves again) and kept as
`stop: {reason, since}`. Shown in `GET /api/project-ticket-autopilot/:project`
(`stopReason`, `stopReasonText`, `stoppedSince`) and in the evening digest
("Stopped: waiting on you").

## 4a. Stalled work (self-heal; CE incident 2026-10-05)

Every tick, before the stop reasons, `processStalledWork` acts on each
`findStalledWork` hit (never over the daily budget):

- re-deliver the brief to the idle assignee (`WorkItemDispatchSubscriber.redispatch`),
  at most once per `stallAfterMs`; traced `stalled_redeliver`;
- after `STALL_MAX_REDELIVERIES` (2) with no progress, the ticket goes back to
  `ready`, unassigned, its WorkItem cancelled (`releaseStalledTicket`); traced
  `stalled_release`. Any ticket change resets the count;
- then every registered idle member with no in-progress ticket (not the lead
  of a multi-member team) is offered the best ready ticket at once
  (`AgentAutoClaimService.tryAutoClaimForAgent`), instead of waiting for an
  idle event.

An assignee that is stopped or still registering (`started`) is not stalled
yet; the next tick looks again, so agents that come back late after a restart
are picked up once they are registered. Boot task recovery measures work age
at boot (not after the restore) from the last status change.

## 5. Switching modes

- **Owner Slack DM to the orc**, handled by the harness (an inbound
  interceptor on the orchestrator bridge, like the team pause command), never
  by the orc's LLM, and only for the owner's own messages in their DM with the
  orc (`ownerDmScope === 'orc'`):
  - `set CE to rush`, `set CE autopilot to chill`, `switch CE to normal`,
    `put CE in rush mode`, `CE rush`, `CE chill mode`
  - `CE 切到 rush`, `把 CE 切换到 chill`, `CE 改成 正常`, `CE 调成冲刺模式`
  - mode words: rush / normal / chill; 冲刺·急速·快·快速 / 正常·普通 /
    慢·慢速·悠闲·佛系
  - consumed only when the target is a known project (id or name, any case;
    names cached for the synchronous interceptor, refreshed every 60 s), or
    when the owner said "project" explicitly (then an unknown name is
    answered with the project list). Anything else goes on to the orc.
  - Reply (English): what the mode does, the budget (explicit kept / mode
    default), an explicit replans-per-day cap if any, "the autopilot is off"
    when it is, and — when switching **to** Rush — a one-line cost warning.
- **Dashboard**: the project page's Autopilot tab has a Rush / Normal / Chill
  selector (owner), the mode's one-line description, the Rush cost warning,
  the stop line and the last self-review.
- **Skill / API**: `execute.sh autopilot --project P --speed rush|normal|chill|default`;
  `POST /api/project-ticket-autopilot/:project {speedMode}`. A change is
  traced (`mode_changed`).
- **Cloud portal control**: out of scope here (follow-up).

## Not changed

- The approval boundary: the autopilot only wakes the driver; it never makes
  tickets ready or starts work.
- The budget brake and boosts.
- Paused teams stay excluded from driving, briefs and self-reviews.

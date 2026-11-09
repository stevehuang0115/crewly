# Stall watcher (2026-10-17)

crewly#1363, crewly#1362. Related: #1360 (promise due from estimates), #1361
(interrupted sub-agents in the handover), #984 (stalls as a metric).

## Problem

On 2026-10-16/17 three kinds of in-flight work stopped and nothing acted:

- **A promise to the owner.** Pia said "a full W41 in about an hour" at 23:15Z.
  Her sub-agent died in a restart; 16 hours of silence. The open-items
  follow-up WorkItem only re-briefs at `due`, and nothing told the lead.
- **A background run.** Rex (another machine) said "已经开跑…预计 1 小时左右" for
  a render he launched, went idle, was idle-stopped. No WorkItem existed, so
  nothing protected him and nobody checked at the hour.
- **A claim with no work behind it.** Ella told the owner "视频已经是 Pia 在做了"
  and never delegated anything to Pia.

Stalls existed only as a metric: `TRACE_CONSTANTS.STALL_MINUTES` marks a gap
with no progress in the autonomy metrics; nothing acted on it.

## Design

One service, `StallWatcherService`
(`backend/src/services/stall/stall-watcher.service.ts`), scheduled every
`INTERVAL_MS` (5 min) after the boot-pressure gate (the same `bootGate` the
wiki maintenance uses), wired in `index.ts` next to open items. Three kinds of
in-flight work, one ladder: **the agent once → its lead once → one plain line
to the owner**. The owner is never the retry loop.

### What it watches

| Kind | Source | Expected-by | Deliverable |
|---|---|---|---|
| (a) Promise to the owner | open-items commitments (`open` / `overdue` / `ready`, with `due`) | `due` (the agent's estimate, parsed by open-items; else the open-items default) | the item leaves the active statuses (the open-items sweep closes it when the agent posts) |
| (b) Claimed WorkItem | active claims on `running` items | — (progress-based) | the trace's ongoing stall ends |
| (c) Background run | an agent post matching `BACKGROUND_RUN_PATTERN` **with** a duration `durationMs` understands (`已经开跑…预计 1 小时左右`, "kicked off the render, about 40 min") | post time + the duration | a later post by the same agent in that thread with a file / link (`DELIVERABLE_PATTERN`) or a finished / failed report (`RUN_FINISHED_PATTERN`) |

Items the ticket autopilot already watches (WorkItems linked to an
in-progress project ticket) are left to it; it re-briefs and releases those.

### The ladder (kinds a and c)

With `est` = the agent's estimate and `made` = promise time / run start:

| Step | When | Who | What |
|---|---|---|---|
| agent | `made + max(1.5 × est, 20 min)` | the agent, one `[STALL]` line | what it said, how long ago, the estimate; for a promise, the **last message by someone else before the promise** (the approval it may be re-waiting for) with "if that was the go-ahead, do not wait for another" |
| lead | `made + 3 × est` | the team lead (`findLeadSessionFor`), one line | the agent has posted nothing since being reminded: check, reassign, or answer the owner |
| owner | lead step + `LEAD_GRACE_MS` (30 min), and the lead has **not** posted in the thread since | the owner-alert notifier (Slack), one line | "Pia 说大约 1 小时 内给「…」，现在过了 3.5 小时 还没有，已经提醒过 Pia，也问了 Ella。" (Chinese when the owner's own messages in the thread are Chinese, else English) |

The owner step repeats at most once per `OWNER_LINE_INTERVAL_MS` (24 h) per
item while it stays stalled. The open-items sweep's own stamps count:
`nudgedAt` for the cooldown, `stallNudgedAt` / `leadNotifiedAt` /
`ownerNotifiedAt` as steps taken; the watcher writes its steps back through
`OpenItemsService.recordStallStep`, so the sweep's own owner note never
doubles the watcher's.

### Claimed WorkItems (kind b)

`stallOf` reads the trace of the WorkItem (`traceByRef('workItem')`, else the
claimer's current trace) and takes the **ongoing** stall from
`TraceAnalysisService.metrics` — the same definition and cause table as the
autonomy metrics (`STALL_CAUSE_LOOKBACK_MS`).

| Window | Condition | Action |
|---|---|---|
| first | ongoing stall ≥ `CLAIM_STALL_MS` (30 min), cause not `waiting_on_owner` | nudge the claimer once with the cause ("runtime out of usage or signed out (…)") |
| second | still ongoing, ≥ 2 × `CLAIM_STALL_MS`, ≥ `CLAIM_STALL_MS` after the nudge | `releaseBack(id, reason, { unassign: true })`: the claim ends, the item is queued again untargeted, and the existing route sweep hands it to the lead and then to the orchestrator (`UNASSIGNED_ROUTE_CONSTANTS`); the lead is told once |

Progress (no ongoing stall) clears the item's ladder, so a later stall starts
a fresh cycle. No owner step for this kind.

### Background runs (kind c)

Records live in `CREWLY_HOME/in-flight-runs.json` (`InFlightRunsStore`):
`{agent, channelId, threadId, head, startedAt, estimateMs, expectedBy}`, one
per agent per thread, dropped after `RUN_MAX_AGE_MS` (24 h) or when the agent
posts the result / a finished or failed report in that thread (live message,
or seen in the thread at check time).

**Protection.** `protectedRunReason(session)` is non-null until
`expectedBy + RUN_PROTECTION_GRACE_MS` (30 min). It is wired into both stop
paths: `IdleWorkGuardDeps.holdsBackgroundRun` (idle stop, hold reason
`background_run`, checked after a stated intent) and
`ProtectionSources.backgroundRunReason` (ResourceMode eviction).

### Claim check (crewly#1362)

On an agent post in an owner thread (a tracked request's thread, or a thread
with an owner message), `detectTeammateClaims` finds "<Name> 在做 / 已经是
<Name> 在做 / 交给 <Name> / 让 <Name> 去做 / <Name> is (already) doing | on |
making | working on / handed it to <Name>" where Name is a member of the
speaker's team (never the speaker; questions and negations skipped). A
planned hand-off is not a claim either (crewly#1427 item 5, 2026-10-23: four
false nudges in one day, each answered with a correction in the owner's
thread): when the text *before* the hand-off carries a future or conditional
marker — `CLAIM_PLAN_ZH` (再 / 才 / 会 / 将 / 然后 / 最后 / 还差 / 下一次 /
如果 / 等你 / 你说 / 你看过 / 说可以 …) or `CLAIM_PLAN_EN` (will / 'll /
once / if / then / going to …) — the sentence is skipped ("你看过说可以，我再
交给 Dex", "会随这次一起交给 Dex"). Words after the hand-off do not count, so
"交给 Pia 了，你点一下看看" stays a claim. The
claim waits `CLAIM_CHECK_WINDOW_MS` (10 min), then `assignmentBackedBy` looks
for a WorkItem targeting that member created within ±10 min by the speaker
(`metadata.delegatedBy` / `createdBy`), by the harness (`owner: 'system'`,
`harnessCreated`) or unstamped, or a project ticket assigned to the member
created within the window by the speaker (`source: agent:<speaker>`), the
harness or with no source. Nothing → the speaker gets one line:

> [CLAIM-CHECK] You told the owner Pia is doing it ("…"); nothing is assigned
> to Pia (…). Delegate it now, or fix the wording in your next reply if you
> misspoke. If it was only a plan for later, do nothing — and never post about
> this note in the owner's thread.

Logged, recorded on the trace (`harness.nudge`, `reason: claim_check`). The
owner is never told.

### Cost control

- Every line to an agent is one line, tagged `[STALL]` / `[CLAIM-CHECK]`.
- One watcher nudge per agent per `NUDGE_COOLDOWN_MS` (30 min, the TL
  delegation cooldown), whatever the kind; a deferred step runs next pass.
- The owner: at most one line per stalled item per day, only after the lead
  had its grace and did not answer.
- Every step is recorded on the trace as `harness.nudge` with `data.reason:
  'stall'` and the step, so the autonomy metrics count interventions.

### Dry run and kill switch

- `CREWLY_STALL_WATCHER=false` switches the watcher off (no passes, no
  records, no protection).
- The first pass stores `armedAt` in the state file; until `ARM_DELAY_MS`
  (24 h) later every pass is a **dry run**: it logs "Dry run: would nudge /
  tell the lead / tell the owner" and sends nothing. Ladder stamps are kept
  in the state file during the dry run (not written to open items), so after
  arming the watcher continues from where the dry run got to instead of
  re-nudging. `CREWLY_STALL_WATCHER_DRY_RUN=true|false` forces it.

### Constants (`STALL_WATCHER_CONSTANTS`)

| Constant | Value |
|---|---|
| `INTERVAL_MS` | 5 min |
| `BOOT_DELAY_MS` | 3 min after the boot gate |
| `ARM_DELAY_MS` | 24 h |
| `AGENT_STEP_MULTIPLIER` / `MIN_AGENT_STEP_MS` | 1.5× / 20 min |
| `LEAD_STEP_MULTIPLIER` | 3× |
| `LEAD_GRACE_MS` | 30 min |
| `NUDGE_COOLDOWN_MS` | 30 min |
| `OWNER_LINE_INTERVAL_MS` | 24 h |
| `CLAIM_STALL_MS` | 30 min (= `STALL_MINUTES`) |
| `RUN_PROTECTION_GRACE_MS` | 30 min |
| `RUN_MAX_AGE_MS` | 24 h |
| `RUN_DEFAULT_ESTIMATE_MS` | 60 min (reserved: runs are only registered with an estimate today) |
| `CLAIM_CHECK_WINDOW_MS` | 10 min |
| `STATE_FILE` | `in-flight-runs.json` |

## Files

- `backend/src/services/stall/stall-watcher.service.ts` — the service, the ladder, the passes
- `backend/src/services/stall/stall-watcher.wiring.ts` — real collaborators; pure helpers (`assignmentBackedBy`, `ongoingStallOf`, `toStallMessage`, `ticketLinkedIds`, `teammatesOf`)
- `backend/src/services/stall/background-run-detector.ts` — run announcements, finished reports, deliverables
- `backend/src/services/stall/claim-check.ts` — "X is doing it" detection and the nudge text
- `backend/src/services/stall/in-flight-runs.store.ts` — the state file
- `backend/src/services/open-items/open-items.service.ts` — `recordStallStep`
- `backend/src/services/agent/idle-work-guard.ts`, `resource-mode-protection.ts`, `follow-through.wiring.ts` — the protection hooks
- `backend/src/types/v2/open-item.types.ts` — `stallNudgedAt`

## Not done

- Project tickets without a linked WorkItem are not watched for progress
  (the ticket autopilot covers in-progress tickets when enabled).
- A promise whose deliverable changes hands or shape (#1362, expectation 2)
  is not detected.
- A "verify" step requiring a WorkItem id in evidence for "X 在做" replies
  (#1362, expectation 3) is not built; the claim check is after the fact.

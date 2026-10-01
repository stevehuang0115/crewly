# Orchestrator status wakes + origin chain (2026-10-01)

## 1. Status reports go to whoever is responsible

**Problem.** Every `report-status` line was queued for the orchestrator. On
2026-09-29 the orchestrator ran 197 turns: 194 for system events, 3 for the
owner. 134 of the system events were agents' `[DONE]`/`[BLOCKED]` lines
(Vera, Nova, Leo, Luna, Sage, Owen, Kai, Lyra…), mostly about work their own
team lead owns and reviews. Each turn re-reads ~70k input tokens.

**Rule** (`services/orc/orc-status-routing.ts`, executed by
`orc-status-router.service.ts`, called from `POST /api/chat/agent-response`):

| Report | Goes to |
|---|---|
| `[IN_PROGRESS]` `[ACTIVE]` `[READY]` `[WORKING]` `[IDLE]` … | recorded only |
| `[DONE]` the owner waits on (OrcDeliveryEnforcer tracked it, #731) | orchestrator |
| `[DONE]` on work the orchestrator delegated (`owner: orchestrator` or `delegatedBy`/`createdBy` = orchestrator) | orchestrator |
| `[DONE]` on any other work item | recorded — the lead's verify/review path takes it |
| `[DONE]` with no work item | digest; actionable only when the sender has no lead |
| `[BLOCKED]` `[FAILED]` `[ERROR]` | the sender's lead (parent member, else team lead) via the queue with `targetSession`; orchestrator when there is no lead or the lead sent it |
| `[MILESTONE]` | orchestrator (it forwards milestones to the owner, #435) |
| other markers / structured reports | digest; actionable on orchestrator work or without a lead |
| no marker (an answer someone waits for) | orchestrator, unchanged |

The work item is the one the report names (`report-status --work-item-id`,
sent as `workItemId`), else the sender's running item (report-status posts
before it completes the item), else one it finished in the last 30 minutes.

**Digest.** The first held report opens a 30-minute window
(`ORC_WAKE_CONSTANTS.DIGEST_INTERVAL_MS`); at its end one `[STATUS DIGEST]`
turn lists only the actionable reports. A window with none is dropped.

**Queue.** A system event for a team lead never coalesces or batches with the
orchestrator's (and back): both match on `targetSession`.

**Counter.** Once an hour: `orc wakes: N (owner X, delegated-done Y,
escalations Z, digest W, other V)` — `N`/owner counted per delivered
orchestrator turn in the queue processor; the routed categories when the
router queues them (coalesced events can make them add up to more than the
turns they caused); `other` = the rest (cron, wiki, triggers, reminders).

**Kept.** Owner messages, orchestrator self-reports (not echoed), the Slack
"Agent Completed" notice, OrcDeliveryEnforcer reminders, the hierarchy
escalation monitor.

**Expected effect on the 9/29 data.** Status-driven orchestrator wakes 134 →
~11 (1 non-status answer + ~10 digests); total orchestrator turns ~197 → ~64.

## 2. Origin chain

**Problem.** 2026-10-01 22:12–22:16Z: the owner asked Atlas in a
#morning-brief thread; Atlas delegated to Sage (WorkItem 3191bc39); Sage's
`[DONE]` made a verify item for Atlas. Atlas attached the answer file, and
`/api/slack/attach` put it in the channel's latest Slack thread — the owner's
unrelated Blender-video thread. No work item carried an owner origin, and the
file path resolved its thread separately from `reply`.

**Rule.**
- `TaskPoolService.addToPool` stamps `metadata.origin` when none is set: the
  parent's origin (`parentWorkItemId`, `verifyOf`, `sourceWorkItemId`), else
  the creating agent's current owner request (fresh turn origin → owner
  origin), else its current work item's origin. Give-up retries copy it.
- `reply` uses an owner origin carried by the work item as the turn origin;
  when that conversation does not take the reply, it posts a new top-level
  message (topic line) in the team channel — never the last owner thread.
- `/api/slack/attach` with no thread named resolves the place with the same
  resolver as `reply` (`resolveAgentSlackDestination`); same channel → that
  thread (or top level with the topic line); otherwise top level. The
  "latest Slack thread in the channel" fallback is gone for files.

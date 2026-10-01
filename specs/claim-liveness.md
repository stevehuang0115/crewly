# Claim liveness and completions that must not be lost

Status: implemented (2026-09-29)

## Incident

WorkItem `f34f09b0` (ticket CE-19, target `ce-vera-d8f94e9c`) was auto-claimed
for Vera four times in one evening. Each claim was revoked by the Reconciler
("Grace period exceeded") while she was working the item. Her `complete` then
got a 409 because the item was back in `queued`, and AgentAutoClaim claimed
the finished item for her again a minute later. It showed `running` for an idle
agent, and no brief was delivered.

## Root causes

1. **Nothing renewed a lease.** Expiry and grace are measured from
   `leaseExpiresAt`, which only `extend-lease` (capped at 3) moved. Agents do
   not run the heartbeat skill, and a heartbeat only stamped `lastHeartbeatAt`
   anyway. So every claim was revoked 10 min + 3 min after it was taken,
   however hard its holder was working.
2. **`complete` required `running`.** When the item was `queued` after a
   revoke, the completion failed `queued → done_by_worker` and the work was lost.
3. **The post-claim brief was deduplicated away.** A batch reminder marks every
   listed (item, agent) pair as delivered, and AutoClaim's `dispatchTo` then
   wrote nothing, so the item went `running` for an idle agent who was never told.
4. **The batch reminder listed three tickets and said "work through them in this
   turn".** An agent can hold one claim, so the other items were worked
   unclaimed.

## Behaviour

- **Liveness renewal.** In both Reconciler loops, a claim whose lease ran out
  is renewed (`→ active`, lease = now + `leaseDurationMs`, not capped by
  `maxExtensions`) when its holder is *visibly working*. That means the session
  is `active`/`started`, is not waiting on a human prompt, and produced
  meaningful PTY output or made an API call within
  `CLAIM_ACTIVITY_LIVENESS_WINDOW_MS` (grace + heartbeat interval = 5 min). A
  holder that has gone quiet expires and is revoked as before, so hung-session
  detection (`getHungAgents`) still works. A session never seen since the
  backend started does not count as working.
- **Heartbeat renews the lease** the same way.
- **Own completions land.** `TaskPoolService.completeItem` on a `queued` item
  whose `target` is the caller's session resumes it (`queued → running`, as
  system, recording `metadata.completedWhileQueuedAt`) and completes it
  normally (verification flow for delegate items). For a broadcast item whose
  claim stamp was dropped on release, the holder of its latest claim counts as
  its agent. Anyone else, or a caller with no session, still fails the
  transition (409).
- **Claim → deliver, or give it back.** AutoClaim (both the direct and the
  project-ticket paths) delivers the brief with `redispatch`, which ignores the
  "already delivered" dedup. If the write fails, the claim is released back to
  `queued` instead of leaving the item `running`.
- **One ticket per reminder.** The Reconciler's redeliver batch is in claim
  order (ticket policy) and carries only the first project ticket's items plus
  non-ticket work. The message tells the agent to take items one at a time and
  not to start an item it has not claimed. The item that triggered the reminder
  backs off even when this rule left it out of the batch.

## Code

- `types/v2/claim.types.ts` — `renewClaimLease`, `CLAIM_ACTIVITY_LIVENESS_WINDOW_MS`
- `services/task-pool/claim.service.ts` — `renewLease`, heartbeat renews
- `services/reconciler/reconcile-rules.ts` — `isAgentVisiblyWorking`, `detectExpiredClaims(…, agentHealthMap)`
- `services/reconciler/reconciler-data-provider.ts` — `AgentHealth.lastActivityAt`, `renewClaim`, redeliver batch
- `services/task-pool/task-pool.service.ts` — `completeItem` resume, `renewClaim`
- `services/v3/agent-auto-claim.service.ts` — `deliverClaimedOrRelease`
- `services/task-pool/ticket-claim-policy.ts` — `limitToOneProjectTicket`

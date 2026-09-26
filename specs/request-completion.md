# Request completion

A Request is **done** when the work it asked for was delivered, not when its
WorkItems happen to be terminal. One module decides this for every writer:
`backend/src/services/v3/request-completion.ts`.

## Writers that close Requests

| Writer | Where | Uses |
|---|---|---|
| Reconciler truth recompute | `reconcile-rules.ts:reconcileRequestStatus` | `evaluateRequestCompletion` on the set from `ReconcilerDataProvider.getWorkItemsForRequest` (`collectRequestWorkItems`) |
| Event cascade | `cascade-request-status.ts` | both |
| Heartbeat stale-close | `request-status-update.subscriber.ts:closeStaleRequest` | both |
| Legacy V3 cascade | `v3-data.service.ts:cascadeRequestStatus` | both |

## The effective WorkItem set (`collectRequestWorkItems`)

1. Every WorkItem with `requestId === request.id`.
2. Unlinked WorkItems (no `requestId`) whose title, description or brief
   contains the full request id — the shape produced when the orchestrator
   pastes a brief (`[Request <id> | WorkItem <id>]`) into `delegate-task`.
3. Transitively (max 5 hops), the successors of cancelled items:
   - explicit: `metadata.supersededBy` (string or string[]), set by
     `POST /api/task-pool/items/:id/cancel` with `supersededBy`, or a
     `succeeded_by` disposition;
   - from the cancel reason, only when it reads as superseding (duplicate,
     stale, re-routed, replaced, …): WorkItem ids in it, full or 8-char
     prefix, resolved by unique prefix.

## The verdict (`evaluateRequestCompletion`)

| Outcome | Condition | Reconciler | Cascade / heartbeat |
|---|---|---|---|
| `complete` | every non-cancelled item is `done`/`verified` and at least one is a deliverable | `done` (or `waiting_confirmation`) | close as `done` |
| `in_progress` | some non-cancelled item is unfinished | running / ready / blocked as before | no close |
| `bookkeeping_only` | every non-cancelled item finished, none is a deliverable | `blocked` with the reason | no close |
| `nothing_live` | every item cancelled | `cancelled` | `cancelled` |

- Cancelled items never count as delivered.
- `done_by_worker` is not delivered (P2 acceptance gate, unchanged).
- Bookkeeping = `metadata.decompositionPhase` of `plan`/`review` (stamped by
  `RequestDecomposeSubscriber` from `PlannedTask.phase`), or, for items that
  predate the stamp, auto-decomposed items titled `Plan:`, `Review:`,
  `Investigate:`, `Verify fix:`. SLA `respond_to_user` trackers are
  bookkeeping, except in a Request that has nothing else — there the reply is
  the deliverable and a tracker resolved by `orc_reply`/`chatv2_reply` counts.

## Dependency-blocked items are not "recoverable"

`detectRecoverableWorkItems` re-queues blocked items whose target agent is
back online. It skips items with an unfinished `dependsOn` prerequisite; those
wait for `detectDependencyResolvedWorkItems`.

## Incident: Request d86b5faf (2026-09-26)

Auto-decomposed into Plan → Execute → Review for `crewly-orc`, plus an item for
Ella. At 03:12:38 the recovery rule re-queued Execute and Review ("agent back
online") while Plan was still queued. The orchestrator re-routed the work to
Ella as a new WorkItem 806dc528 (request id only in its title), completed Plan
and Execute as "re-routed / no execution needed" (both auto-verified — the
orchestrator has no reviewer above it), and cancelled Review and Ella's item as
duplicates naming 806dc528. At 03:49:08 the reconciler saw
`{verified:2, cancelled:2}` and closed the Request; 806dc528 was still running.

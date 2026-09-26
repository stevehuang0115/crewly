# WorkItem verification gate — reviewed before it counts (#813)

Status: implemented (PR #819). Owner: task-pool. Related: #763 (criteria grow from review), `specs/ticket-loop.md`, `specs/2026-08-21-workitem-successor-model.md`, `.crewly/specs/2026-09-24-control-plane-isolation.md`.

## Claim this makes true

A WorkItem reaches `verified` only when its reviewer verifies it: the owning lead, the orchestrator once the review is escalated to it, or the owner. No timer, sweeper, fallback or role claim can certify work.

## What was wrong (main @ 4db11b23)

Four paths moved `done_by_worker → verified` as actor `system`:

| # | Path | Fix |
|---|------|-----|
| 1 | Reconciler TTL picker `['cancelled','verified','done']`: 24h of silence became `verified` | `verified` removed from the list; the owner is escalated instead (below) |
| 2 | EventToWorkItemBridge: when there was no separate lead, `verifyItem(system,'verified')` | The review goes to the orchestrator |
| 3 | `RequestSlaSubscriber.markResolved`: `pickResolveTarget('done_by_worker') = 'verified'` | Returns `null`; the item is left for its reviewer |
| 4 | Review-item completion propagated the verdict as `system` (the real TL path), so *who* reviewed was lost | Propagated as the caller, and checked before the review item closes |

In the live pool on 2026-09-26, 25 of 293 `verified` items had a review item. 123 were trigger-fired check-ins, which are now exempt from review (see "What needs review").

## The gate — `backend/src/types/v2/work-item.types.ts`

```ts
type TransitionActorRole = WorkItemOwner | 'owner';
interface TransitionActor { role: TransitionActorRole; session?: string; via?: string }
checkTransitionPermission(item, to, actor): { allowed: true } | { allowed: false; reason; detail }
```

Rules, in order:

1. **No actor → refused** (`missing_actor`). There is no default role. `updateItemStatus`, `transitionStatus` and `completeItem` all require one.
2. **Closed table.** `TRANSITION_PERMISSIONS` has an entry for every legal edge in `WORK_ITEM_TRANSITIONS` (26 today). Any other `from→to` is refused for every actor, `system` included (`unlisted_transition`). A test fails if a legal edge is added without an entry.
3. **Role check** (`role_not_permitted`). `system` is listed on the edges server code takes and no longer bypasses the table.
4. **Verdict edges** (`done_by_worker→verified|rejected`) also require identity:
   - `owner`: always.
   - `team_lead`: only as the reviewer of record, matched by `session`. A bare role string has no session, so it is refused.
   - `orchestrator`: as the reviewer of record, when no reviewer is recorded, or once the review was escalated to it or to the owner (`metadata.verifyEscalatedAt` / `reviewOwnerEscalatedAt`).
   - The worker (`session === item.target`) is never its own reviewer (`self_review`).
   - `system` may take `→rejected` (the SLA escalation timeout sends work back). It may never take `→verified`.

**Reviewer of record** = `metadata.reviewer` if set, otherwise the target of the item's review WorkItem (`<id>:verify:<id>`, created by the bridge for the worker's parent, else the team lead, else the orchestrator). When a review item is completed, its target is written to the source's `metadata.reviewer`. A verdict records `reviewedBy`, `reviewedByRole` and `reviewedAt`.

A refusal throws `ForbiddenTransitionError` (`reason`, readable `detail`), which controllers map to **HTTP 403** with `code: transition_<reason>`.

## Who the actor is

`resolveTransitionActor(req, via)` in `backend/src/utils/agent-caller.utils.ts`:

| Request | Actor |
|---|---|
| `X-Agent-Session: crewly-orc` | `orchestrator` + session |
| `X-Agent-Session: <other>` | `agent` + session (acts as reviewer on a verdict) |
| no header, `X-Crewly-Caller: dashboard` | `owner` |
| no header | `agent`, **no session**: can take worker edges, can never review |

The body's `agentId` is never used for identity. **Limitation:** the header comes from the agent's own environment (`lib.sh`), so it is the best identity available now, not an authenticated one. Per-session API tokens (control-plane isolation spec) replace it, and this function is the single place to change.

## Rendering a verdict

- **Complete the review item** (unchanged for TLs): `report-status` / `complete-task` on `<id>:verify:<id>`; `{"verdict":"rejected","feedback":"…"}` sends it back. The verdict is checked **before** the review item is marked done, so a refused caller gets 403 and the review item stays open.
- **`POST /api/task-pool/items/:id/verdict`** `{verdict, comment?}` is for the orchestrator after escalation and for the owner.

## Escalation instead of auto-verify

lead (review item) → **orchestrator** at 2h (`DEFAULT_VERIFY_ESCALATE_MS`, stamps `verifyEscalatedAt`) → **owner** at 24h (`detectUnreviewedPastTTL`, stamps `reviewOwnerEscalatedAt`, one `tl_verification` escalation with target `human`). Each step fires once per item, and the stamps survive restarts. The item stays `done_by_worker`, so its blocked dependents stay blocked until someone renders a verdict. That is the intended trade-off: unreviewed work does not unblock downstream work.

`PruningResult.ttlAutoVerifiedCount` is kept as a tripwire. It should always be 0, and the reconciler warns if it is not.

## What needs review (`TaskPoolService.requiresVerification`)

An explicit `metadata.requiresVerification` wins. Otherwise `delegate` items need review, except:
- trigger-fired check-ins (`triggerId` set: schedule-followup / watch-for-event), and
- bridge-auto maintenance items (`metadata.autoCreated`).

Those complete as `done`. Nothing reviews them; before this change they were parked in `done_by_worker` and auto-verified. The bridge still skips review items for `cron_run` / auto items unless they explicitly require verification.

## Accepted is not verified

- **Tickets** (`specs/ticket-loop.md`): a ticket closed by silence is stored as `acceptedBy: 'silence'` (and still tagged `auto_accepted`); the owner's 验过了 is stored as `acceptedBy: 'owner'`. The board DTO carries `acceptedBy`, and done cards show **已验收** or **默认通过 · 未验收**.
- **Reports**: the Slack request heartbeat counts `done_by_worker` as **待验收**, never as 已完成.

## Adding a transition

Add the edge to `WORK_ITEM_TRANSITIONS` **and** a `TRANSITION_PERMISSIONS` entry naming the roles that take it, then bump the edge count pinned in `work-item.types.test.ts`. Pass an explicit actor (`{ role: 'system', via: '<component>' }` for server code).

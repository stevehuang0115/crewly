# Successor model for `rejected` / `failed` WorkItems

Status: DESIGN — awaiting TL (Sam) + Arch (Victor) sign-off before implementation.
Author: Leo (developer). WorkItem 702ef3d1, Deliverable A.
Base: `origin/main` @ fc2bb6df (which already contains Deliverable B, merged as PR #733 / 13e40ac7).

---

## 0. Why this document exists

`469a3a21` reverted `detectStrandedRejectedWorkItems` / `requeueAfterRejection` because the
successor predicate was wrong in both directions. The revert note asked for "a real successor
model, not a bolt-on". This is that model.

The single most important finding is in §3: **the reverted rule failed because it tried to
INFER a successor by scanning other WorkItems.** Inference over a live collection is wrong in
both directions by construction — you cannot see successors the query filters out, and you
cannot distinguish a successor from an unrelated child. The fix is not a better query. It is
to stop inferring and make disposition an **explicit, recorded property of the WorkItem
itself**.

---

## 1. The state-machine fact that creates the stranding

`WORK_ITEM_TRANSITIONS` (`backend/src/types/v2/work-item.types.ts:343`):

```ts
rejected:       new Set(['queued']),
failed:         new Set(['queued']),
verified:       new Set<WorkItemStatus>(),
done:           new Set<WorkItemStatus>(),
cancelled:      new Set<WorkItemStatus>(),
```

`TERMINAL_WORK_ITEM_STATUSES` (`:133`) = `{done, verified, cancelled}`.

So `rejected` and `failed` are the only two statuses that are **neither terminal nor able to
reach a terminal state**. Their sole outbound edge is `→ queued`. A WI parked in either one
is finished as far as every consumer is concerned but unfinished as far as the state machine
is concerned, and *nothing owns closing the gap*.

The codebase already knows this. `SLA_TERMINAL_WORK_ITEM_STATUSES` (`:161`) exists purely to
paper over it, and its own JSDoc says so:

> treat `failed` and `rejected` as terminal for *their* purposes — even though those statuses
> are NOT terminal in the strict state-machine sense

**The stranding is the delta between those two sets.** That is the bug, stated exactly.

---

## 2. Eval 1 — exhaustive enumeration of paths into `rejected` / `failed`

### 2a. Into `rejected`

| # | Path | Successor today | Verdict |
|---|---|---|---|
| R1 | `TaskPoolService.verifyItem(verdict='rejected')` — `task-pool.service.ts:1157` | Publishes `task:rejected` (`:591`) → `EventToWorkItemBridge` (`:297`) creates successor WI `${sourceWI.id}:retry:${n}` (`event-to-workitem-bridge.service.ts:488`), or an escalation WI at cap (`:454`). | **HAS successor.** Correct as-is. |
| R2 | `RequestSlaSubscriber.failOrphanRespondWi` → `pickFailTarget('done_by_worker') === 'rejected'` — `request-sla.subscriber.ts:226`, called from **4 sites** (`:1436, :1445, :1454, :1483`) | Calls `taskPool.transitionStatus(...)` **directly** (`:1517`). Does not go through `verifyItem`, so `task:rejected` is **never published**, so the bridge never fires. | **STRANDED.** No successor, no terminal edge, no audit beyond one `logger.info`. |
| R3 | `proposed → rejected` — legal per the table, gated to `owner='agent'` by `TRANSITION_PERMISSIONS` (`:380`) | No production writer found. Reachable via the generic `transitionStatus` guard only. | **Unwired but reachable.** Must be closed by the safety net (§4.3), not by a dedicated rule. |

> **Correction to PR #733's premise — VERIFIED BY EXECUTABLE PROOF, NOT ARGUMENT.**
>
> #733's body states that `rejected` is *"unreachable in production"* and that a successor for
> it was therefore deliberately not scheduled.
>
> The *evidence* #733 cites is correct: an independent sweep of every writer confirms
> `verifyItem` has exactly one production call site (`task-pool.service.ts:1107`), hardcoded to
> `'verified'`; there is no verify/reject HTTP route (`task-pool.routes.ts:36-104`); no skill
> writes a verdict; and `proposed → rejected` (R3) has zero writers. So R1 and R3 are indeed
> dead.
>
> The *conclusion drawn from it is false.* The sweep was over `verifyItem`, and `verifyItem` is
> not the only writer. **R2 reaches `rejected` in production today** via `pickFailTarget`, from
> a subscriber booted at `index.ts:664`, on a 10-minute `setTimeout` (`:1205`), with four live
> call sites — one of which is a `finally` block (`:1483`) that runs on *every* escalation
> regardless of outcome.
>
> Proven mechanically rather than asserted (5/5 green):
> 1. `SLA_TERMINAL_WORK_ITEM_STATUSES.has('done_by_worker') === false` → the guard at `:1508`
>    does not stop it;
> 2. `pickFailTarget('done_by_worker') === 'rejected'`;
> 3. `WORK_ITEM_TRANSITIONS['done_by_worker'].has('rejected') === true` → `transitionStatus` accepts it;
> 4. `[...WORK_ITEM_TRANSITIONS['rejected']] === ['queued']` → no terminal escape;
> 5. `pickTTLExpiryTarget('rejected') === null` and `pickCascadeTarget('rejected') === null`
>    → post-#733 every pruning rule deliberately skips it, so nothing will ever clean it up.
>
> Together those five are the stranding, end to end, with no timing and no mocks.
>
> **Frequency, stated honestly:** the `respond_to_user` WI is born `queued`
> (`request-sla.subscriber.ts:1600`), and `pickFailTarget('queued')` returns `'cancelled'`. So
> the common case is benign. `rejected` requires the WI to have reached `done_by_worker` — i.e.
> the orchestrator reported done but no `VERIFIED_REPLY_REASON` cleared the tracker — before
> the 10-minute timer fires. That is a narrow window, not a rare-in-principle one: it is exactly
> the "worker done, TL has not verified" state that `enforceVerification` exists to service and
> that the code elsewhere expects to persist for hours.
>
> **This does not invalidate Deliverable B.** #733's *code* is correct and its pickers are
> right. What is wrong is one paragraph of its rationale, and the follow-up it de-scheduled on
> the strength of that paragraph. Escalated to Sam (who authored the claim) before any fix code
> was written.

### 2b. Into `failed`

| # | Path | Successor today | Verdict |
|---|---|---|---|
| F1 | `V3DataService.onTaskFailed` → `failItem` — `v3-data.service.ts:461` | Re-reads the WI, then branches (`:473`): `retryCount < maxRetries` → `requeueAfterFailure`; else → `escalateFailedWorkItem`. | **HAS successor (retry) or audit (escalation).** Correct as-is. This is the reference implementation the other paths should match. |
| F2 | Reconciler emits `newState:'failed'` → `applyCorrection` — `reconciler-data-provider.ts:490` | Explicitly escalates via `escalateFailedWorkItem` with a comment noting it bypasses the canonical event path. | **HAS audit.** Correct as-is. |
| F3 | `failOrphanRespondWi` → `pickFailTarget('running') === 'failed'` — `request-sla.subscriber.ts:225` | Raw `transitionStatus`. No `failItem`, no event, no escalation. Falls through to the reconciler's `detectRetryableFailedWorkItems` (`reconcile-rules.ts`), which requeues **only if** `retryCount < maxRetries`. | **PARTIALLY covered.** Retries-remaining self-heals by luck. **Retries-exhausted → STRANDED**, with no escalation record. |
| F4 | Bridge's own failure modes: `resolveSourceWorkItem` returns `null` (`:~380`, `event.workItemId ?? event.taskId` missing or WI not found); TL-parse throw; `retryId` `${id}:retry:${n}` colliding with an already-terminal retry WI so `addToPool` no-ops | Source WI stays `rejected`; the successor that was supposed to exist never does. | **STRANDED,** and invisibly so — this is the failure mode that makes *inferring* a successor unsafe. |

### 2c. The stranded set, stated precisely

1. **S1** — `rejected` written by any path other than R1 (today: R2, and R3 if ever wired).
2. **S2** — `failed` with `retryCount >= maxRetries` written by any path other than F1/F2 (today: F3).
3. **S3** — `rejected`/`failed` whose intended bridge successor silently failed to materialise (F4).

Everything else already has a successor or an audit record and must **not** be touched.

### 2d. One survey claim rejected

An independent sweep of this area reported that the TTL rule still emits an illegal
`rejected → cancelled` every 60s for any `rejected` WI older than 24h. **That is false on
`main` and I am recording it here so it does not propagate.** It describes the pre-#733 world.
`pickTTLExpiryTarget` (`reconcile-rules.ts:~590`) walks `TTL_EXPIRY_TARGET_PREFERENCE` and
returns a candidate only if it is BOTH strictly terminal AND a legal outbound edge; for
`rejected`/`failed` the only edge is `queued`, which is not terminal, so it returns `null` and
`detectTTLExpiredWorkItems` skips. Verified by direct execution (§2a proof, assertion 5).
The practical consequence matters for this design: post-#733 the stranding is **silent**. There
is no longer a recurring error log to notice it by.

---

## 3. Eval 2 — why the reverted predicate was wrong, and why this one cannot be

The reverted rule asked: *"does a successor WorkItem exist for this source?"* — answered by
scanning `getActiveWorkItems()` for a child. Both failure directions follow from the question,
not from the implementation:

- **False "yes" is impossible to rule out.** `ReconcilerDataProvider.getActiveWorkItems()`
  (`reconciler-data-provider.ts`) filters `status !== 'done' && status !== 'cancelled'`. A
  successor that already completed is invisible → the rule concludes "no successor" → it
  re-dispatches the source → **already-completed work runs twice.**
- **False "no" is equally structural.** `buildAutoWorkItem` sets `parentWorkItemId` on the
  VERIFY WI as well as on retry WIs, so an unrelated VERIFY child reads as a successor → the
  rule skips → **the exact SLA case it was written to rescue is the case it skips.**

No refinement of the query fixes this, because the query is reconstructing information the
writer already had and threw away.

**The predicate in this design is a local field read, not a scan:**

```
isDisposed(wi) := wi.metadata.disposition !== undefined
```

- It cannot suffer a visibility bug: there is no collection to filter.
- It cannot suffer a false-parent bug: `parentWorkItemId` is not consulted.
- It is stamped by the same operation that performs the disposition, so "recorded" and
  "actually happened" cannot drift.

---

## 4. The model

### 4.1 One funnel, three dispositions

Every writer that parks a WI in `rejected`/`failed` must route through a single funnel on
`TaskPoolService`:

```ts
disposeFailedWorkItem(workItemId, { reason, actor }): Promise<Disposition>
```

which resolves to exactly one of:

| Disposition | When | Effect |
|---|---|---|
| `retried_in_place` | `retryCount < maxRetries` | `failed → queued` via the existing `requeueAfterFailure` (bumps `retryCount`). Stamp `{kind:'retried_in_place', at, by, reason}`. |
| `succeeded_by` | The path owns a *new* successor WI (R1/bridge) | Source keeps its status; stamp `{kind:'succeeded_by', successorWorkItemId, at, by}`. |
| `terminal` | Retries exhausted, or the status has no retry path (`rejected` outside R1) | `escalateFailedWorkItem` for the audit record + orchestrator verdict. Stamp `{kind:'terminal', escalationId, at, by, reason}`. |

### 4.2 Deliberately NOT changing `WORK_ITEM_TRANSITIONS`

The tempting move is to add `failed → cancelled` / `rejected → cancelled` so a disposed WI can
reach a strictly-terminal status. **Rejected.** Victor's Expected Outcome permits *"a deliberate
terminal state with an audit record"* — and `failed` + a `terminal` disposition stamp **is**
exactly that. Adding the edges would:

- re-open the surface PR #733 just closed (TTL/orphan/cascade would start emitting corrections
  for these statuses again, and `pickTTLExpiryTarget`/`pickCascadeTarget` would need re-deriving);
- convert a *deliberate* terminal decision into a *default* one after 24h, which is the very
  auto-acceptance semantic #733 removed;
- for zero benefit — nothing downstream requires `cancelled` specifically; every consumer
  already reads `SLA_TERMINAL_WORK_ITEM_STATUSES`.

Consequence: the reconciler's soundness property is preserved untouched. `rejected`/`failed`
still have no legal terminal edge, so the pruning rules still legally **skip** them. The new
rule (§4.3) does not emit a status correction at all for the terminal case — it stamps and
escalates. **Zero new illegal-transition surface.**

### 4.3 The reconciler's role: safety net only

New rule `detectUndisposedFailedWorkItems`:

```
for wi in workItems:
  if wi.status not in {rejected, failed}: continue
  if isDisposed(wi): continue                       # idempotent — re-entrant by construction
  if age(wi, since = lastStatusChange) < GRACE_MS: continue   # let the eager writer win
  → run the funnel
```

- **Terminating (Eval 4):** every funnel outcome writes a stamp; a stamped WI is skipped
  forever after. The `retried_in_place` branch additionally bumps `retryCount` through
  `requeueAfterFailure`, so `maxRetries` stays reachable and the retry branch can fire at most
  `maxRetries` times.
- **Re-entrant (Eval 4):** the stamp is the idempotency key. Two concurrent passes converge.
- The grace window exists so the eager writers (§4.4) own the common case and the reconciler
  only catches F4-class silent failures.

### 4.4 Writer changes

- `RequestSlaSubscriber.failOrphanRespondWi` — after its `transitionStatus`, call the funnel.
  This closes R2 and F3 at the source, i.e. the reproducible path.
- `EventToWorkItemBridge` — on the success path, stamp `succeeded_by` with the retry/escalation
  WI id. This makes R1 explicitly disposed instead of *inferably* disposed, and turns every F4
  failure mode into a visible "undisposed" that the safety net picks up.

### 4.5 Eval 3 — not reviving the 24h TTL problem

`detectTTLExpiredWorkItems` measures age from `wi.createdAt` and applies to **all** non-terminal
statuses, `queued` included. `requeueAfterFailure` does **not** reset `createdAt`.

**This is a live latent defect on `main` today, independent of this design:** a WI that fails
after 24h and is auto-retried by `detectRetryableFailedWorkItems` lands in `queued` with a
>24h `createdAt`, and the TTL rule cancels it on the very next 60s pass — silently destroying
the retry that was just granted.

Fix, chosen to avoid mutating `createdAt` (which feeds age metrics and ordering elsewhere):
introduce a **TTL anchor**, `ttlAnchorAt = metadata.lastRequeuedAt ?? createdAt`, written by
`requeueAfterFailure` and read by `detectTTLExpiredWorkItems`. Each granted retry gets a fresh
TTL window; `createdAt` keeps meaning "when this work was first asked for".

---

## 5. Eval 5 / 6 — verification plan

- **Eval 6 (reproduce the stranding, not the revert):** drive `failOrphanRespondWi` on (a) a
  `done_by_worker` WI → asserts it lands in `rejected` with no successor and no event; (b) a
  `running` WI at `retryCount === maxRetries` → asserts `failed`, no escalation, and that a
  full reconciler cycle leaves it untouched forever. Both are deterministic — no timing, no
  reliance on the reverted rule existing.
- **Eval 5 (invariant, extended not replaced):** the existing derived-from-`WORK_ITEM_TRANSITIONS`
  liveness+soundness tests (`reconcile-rules.test.ts:543`, `:686`, `:738`) are extended with a
  **full-cycle** invariant at the `ReconcilerService` level: seed one WI in every
  `WorkItemStatus`, run a complete `runFull`, and assert every applied correction is a legal
  edge (soundness) **and** that no WI in `rejected`/`failed` remains undisposed after the grace
  window (liveness). Liveness is what the reverted rule lacked and what makes "do nothing"
  fail the test.
- Mutation checks: removing the stamp must fail the termination test; removing the TTL anchor
  must fail the Eval-3 test; restoring the scan-based predicate must fail both Eval-2 direction
  tests.

---

## 6. Scope judgement (architectural veto — NOT exercised)

Victor and Sam both granted a veto if this needs Request-layer successor modelling. **I am not
exercising it.** Everything above is contained to the WorkItem layer: one new funnel on
`TaskPoolService`, one metadata field, one reconciler safety-net rule, two writer call sites,
one TTL anchor. `WORK_ITEM_TRANSITIONS` is untouched (§4.2) and no Request-layer relationship
is introduced.

Two things do need explicit sign-off because they are decisions, not details:

1. **§4.2** — accepting `failed`/`rejected` + disposition stamp as the deliberate terminal
   state, rather than adding `→ cancelled` edges.
2. **§4.5** — the TTL anchor, which changes TTL semantics for every requeued WI (and fixes a
   defect that predates this work).

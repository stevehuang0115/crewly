# Pipeline Gap: Request → WorkItem Decomposition Is Unwired

> **Status:** Diagnosis spec — Tier-2 fix proposal pending review
> **Author:** Leo (developer, Crewly Product team)
> **Reviewers:** Sam (TL), ORC, Mia (PM)
> **Filed:** 2026-05-05
> **Reference Request:** `739e9dca-8507-4f19-9d2a-96ab2381822f` (Sam's dogfood Request — itself an instance of this bug)
> **Priority:** P1
> **Spec scope:** Identify root cause of empty `Request.workItemIds`, propose Tier-2 fix (≤300 LOC, no breaking changes)

---

## 1. Symptom

Pipeline #4 (Request → WorkItem decomposition) is silently broken in production.

**Live evidence captured 2026-05-05T21:30Z:**

| Request ID | `workItemIds` | Status | Closed via | Title (truncated) |
|---|---|---|---|---|
| `739e9dca` (Sam's dogfood) | `[]` | done | (no `result` set) | "[P1 dogfood] Pipeline #4 gap…" |
| `53f96867` | `[]` | done | `orc_reply` | "好的 现在就处理吧" |
| `2971e9c9` | `[]` | done | `orc_reply` | "我同意你的 就是orc目前还是以routing为主…" |
| `e5ed8202` | `[]` | done | (empty) | "我们不是在这个thread讨论这个问题吗：" |
| `f0f52b65` | `[]` | done | `orc_reply` | "[Slack File: …]" |
| `8609982d` | `[]` | done | `orc_reply` | "那现在是否需要重启OSS？" |

100% of sampled real planning Requests today have `workItemIds: []`. They flip to `done` within minutes via the SLA `orc_reply` cascade. The pipeline never decomposes them into pool WorkItems.

**Compounding problem (auto-Request spam):** every default-intent Slack message in `D0AC7NF5N7L` becomes a Request, including trivial replies ("好的", "我同意你的…"), file uploads, and "are we still discussing this in the thread?" follow-ups. Mia counted ~58 auto-Requests/day from a single user, of which ≥80% are non-actionable.

---

## 2. Root Cause — Five-Layer Architectural Gap

Sam's initial single-cause hypothesis ("orc has no `materialize-workitems` skill, so the prompt instruction is unexecutable") is the visible top layer. The full failure spans **five layers**, and any one of them is sufficient to leave `workItemIds` empty.

### Layer 1 — Orchestrator has no skill that completes the prompt instruction

`backend/src/services/ai/prompt-builder.service.ts:374` instructs the orc:

> *"if intentLevel ∈ {L1, L2}, call `POST /api/requests/plan`… if you accept, **materialise WorkItems whose `requestId` is the new Request**."*

`config/skills/orchestrator/` has 50+ skills (verified by `ls`). **Zero** of them materialize WorkItems with a `requestId`:

- `orchestrator/delegate-task` — bug-loaded, see Layer 2.
- No `orchestrator/break-down-request`, `orchestrator/materialize-workitems`, or `orchestrator/decompose-request`.
- `agent/core/break-down-request` and `agent/v3/plan-request` exist as **agent** skills but are not surfaced in the orchestrator skill catalog by directory convention.

Net effect: the orc reads the prompt, has no tool to act on it, and falls through to `reply-slack`.

### Layer 2 — `orchestrator/delegate-task` calls a 404 endpoint

`config/skills/orchestrator/delegate-task/execute.sh:196`:
```bash
POOL_RESULT=$(api_call POST "/pool/add" "$POOL_BODY" 2>/dev/null || echo '{"success":false}')
```

But the route is mounted at `/api/task-pool` (`backend/src/routes/api.routes.ts:165`), not `/api/pool`. **Live probe of running backend (port 8787) confirms `POST /api/pool/add` returns 404; `POST /api/task-pool/add` returns 400** (validation error, route exists).

Additionally, even if the URL were correct:
- The skill builds `POOL_BODY` with **no `requestId` field** (line 186-194).
- The skill has **no `--request-id` flag**.

Result: even when used, this skill cannot tag a WorkItem with the parent Request.

### Layer 3 — `/task-pool/add` does not emit `v3:task_delegated`

The only path that calls `requestService.linkWorkItem(requestId, workItemId)` is `V3DataService.onTaskDelegated` (`backend/src/services/v3/v3-data.service.ts:308`), which subscribes to `v3:task_delegated`.

`v3:task_delegated` is emitted from **exactly one** site: `backend/src/controllers/task-management/task-management.controller.ts:275` (the `/api/tasks/create-and-delegate` flow that writes a `.crewly/tasks/...` markdown file).

`TaskPoolService.addToPool` (`backend/src/services/task-pool/task-pool.service.ts:194-225`) emits **`workitem:queued`** but **not** `v3:task_delegated`. So even a correct `POST /api/task-pool/add` with `requestId` in the body does **not** trigger `linkWorkItem`. The WorkItem is created with `requestId` set on the WI itself, but `Request.workItemIds` never receives the ID.

### Layer 4 — `PUT /api/requests/:id` silently drops `workItemIds`

`agent/core/break-down-request` (the closest existing materialization skill) tries to compensate at line 181-183 by calling:
```bash
LINK_BODY=$(printf '%s' "$WORK_ITEM_IDS" | jq '{workItemIds: .}')
api_call PUT "/requests/$REQUEST_ID" "$LINK_BODY"
```

But `UpdateRequestInput` (`backend/src/types/v2/request.types.ts:172-189`) does **not** include `workItemIds`, and `RequestService.update` (`backend/src/services/v3/request.service.ts:262-300`) only applies known fields. The `workItemIds` field is silently dropped. The PUT returns 200, the skill logs success, the array stays empty.

### Layer 5 — SLA `orc_reply` race closes the Request before any decomposition can complete

The auto-Request creator in `backend/src/services/slack/slack-orchestrator-bridge.ts:417-444` runs inside `setImmediate(...)` — fire-and-forget. In parallel, `sendToOrchestrator` (line 447) collects the orc's reply. Because `fromOrcReply=true` on the default intent path, `sendSlackResponse` calls `markResolvedByThread` (line 1476) which calls `markResolved(requestId, 'orc_reply')` which cascade-closes the Request to `done`.

Time-to-close from the live data: **3-4 minutes** for Sam's reference Request, **<1 minute** for typical Slack replies. This is shorter than any plan→materialize multi-step the orc could plausibly run via shell skills. The SLA subscriber (`backend/src/services/v3/request-sla.subscriber.ts`) anticipates this race in code comments and has a retry, but the retry resolves the *respond_to_user* WI — not the materialization gap.

The cascade-close is even *correctly* gated to suppress when other non-terminal WIs exist for the Request (`maybeCloseRequest` line 791-794) — but because Layer 3 prevents WIs from being linked to the Request in the first place, there are no siblings for the gate to find. The defense fails open.

### Why `workitem_decompose` exists but never fires

`request-sla.subscriber.ts:1081` calls `markResolved(requestId, 'workitem_decompose')` from `handleWorkItemQueued`. The reason tag is in `VERIFIED_REPLY_REASONS` (line 297). It exists for a future where the orc decomposes a Request before replying. **It currently has no upstream producer** — no skill ever creates a `workitem:queued` event with the right `requestId` *before* the orc replies. The decompose-side of the contract is wired in receivers but not in producers.

### Verification matrix

| Sam's hypothesis pin | Verified | Refinement |
|---|---|---|
| `plan()` is stateless proposal at `request.service.ts:375` | ✓ | line is `375`, returns `RequestPlan { tasks, reasoning, strategy }`, never persists |
| `POST /api/requests/plan` returns plan, no materialize | ✓ | `request.controller.ts:141-142` |
| `createRequestHandler` does NOT auto-call `plan()` | ✓ | `request.controller.ts:88-113` |
| `request-sla.subscriber.ts` creates respond_to_user SLA WI, NOT in workItemIds | ✓ | uses deterministic id `request:${requestId}:respond_to_user`; never calls `linkWorkItem` |
| `markResolvedByThread` orc_reply path cascade-closes Request | ✓ | `slack-orchestrator-bridge.ts:1476` → `request-sla.subscriber.ts:620-636` → `markResolved` → `maybeCloseRequest` |
| `workitem_decompose` resolution exists at line 1081 | ✓ | line 1081, but no producer |
| Prompt at `prompt-builder.service.ts:374` instructs plan + materialize | ✓ | lines 367-377 of the file in this checkout |
| No `materialize-workitems` orchestrator skill | ✓ | extended: also no working `decompose-request` for orc; agent skill `break-down-request` exists but is not in the orchestrator catalog |

---

## 3. Architectural Gap Summary

**It is not a single missing skill. It is a five-layer gap:**

1. No orchestrator-discoverable skill for materialization (Layer 1).
2. The closest orchestrator skill (`delegate-task`) is broken at the API layer (Layer 2).
3. The pool's HTTP entry point doesn't emit the event that triggers `linkWorkItem` (Layer 3).
4. The Request update endpoint silently drops `workItemIds` (Layer 4).
5. The Slack orc-reply path closes the Request before any plan→materialize sequence can run (Layer 5).

Layers 1-4 are silent producers/consumers of `Request.workItemIds = []`. Layer 5 ensures that even a heroic orc cannot win the race. **Fix any subset of {1,2,3,4} alone and the user-visible symptom remains** (because Layer 5 still closes the Request before decomposition lands). **Fix Layer 5 alone and the symptom remains** (because Layers 3 + 4 prevent `linkWorkItem` from ever firing). The fix must address at least one producer-side layer **and** Layer 5.

---

## 4. Tier-2 Fix Proposal (≤300 LOC, no breaking changes)

The proposal is structured as five small, independently-shippable patches. Total LOC estimate: **~145**, well within the 300 budget.

### Patch A — Wire `linkWorkItem` from `workitem:queued` (≈15 LOC)

**File:** `backend/src/services/v3/request-sla.subscriber.ts`
**Wire-point:** `handleWorkItemQueued` (around line 1080), **before** the `markResolved` call.

Add:
```ts
// Bidirectional link: pool entry → Request.workItemIds.
// Idempotent (linkWorkItem already short-circuits on duplicate).
if (incomingWorkItemId !== respondToUserWorkItemId(requestId)) {
  try {
    await this.requestService.linkWorkItem(requestId, incomingWorkItemId);
  } catch (err) {
    this.logger.warn('linkWorkItem from workitem:queued failed', { requestId, workItemId: incomingWorkItemId, error: formatError(err) });
  }
}
```

This collapses Layers 3 + 4 into a single fix — the SLA subscriber already has access to `requestService` (constructor-injected), already runs on every `workitem:queued`, and the work item already carries `requestId`. No new event vocabulary, no new endpoint.

**Test:** extend `request-sla.subscriber.test.ts` to assert `linkWorkItem` is called once per `workitem:queued` for tracked Requests, and **not** for the self-recursion case.

### Patch B — Fix `delegate-task` URL + add `--request-id` flag (≈10 LOC)

**Files:**
- `config/skills/orchestrator/delegate-task/execute.sh` line 196: `/pool/add` → `/task-pool/add`.
- Same file: add `--request-id|-R` flag parsing, pipe into `POOL_BODY` as `requestId`.

```bash
--request-id|-R) REQUEST_ID="$2"; shift 2 ;;
# … in jq -n call:
'{... } + (if $requestId != "" then {requestId: $requestId} else {} end)'
```

**Test:** unit test in `delegate-task/execute.test.sh` (or smoke via curl mock) confirming the body shape and URL.

### Patch C — Add `orchestrator/break-down-request` alias (≈30 LOC)

**File:** new `config/skills/orchestrator/break-down-request/{SKILL.md,execute.sh}`.

Implementation: a thin shim that `exec`s `agent/core/break-down-request/execute.sh "$@"`. SKILL.md mirrors the agent version with `assignableRoles: [orchestrator]` so it appears in the orchestrator catalog.

This unblocks Layer 1 without forking logic. Future work can promote the canonical implementation under `orchestrator/` if duplication becomes a concern.

**Alternative (zero-LOC):** add `orchestrator` to the existing agent skill's `assignableRoles` list (line 8 of `agent/core/break-down-request/SKILL.md`) and update the orchestrator skill loader to scan `agent/core/` for skills tagged `orchestrator`. Slightly more invasive (touches the skill loader), but eliminates duplication. Recommend Patch C alias for the Tier-2 ship; revisit during a Tier-3 skill catalog cleanup.

### Patch D — Tighten Slack auto-Request creator (≈40 LOC)

**File:** `backend/src/services/slack/slack-orchestrator-bridge.ts`, the `setImmediate` block at line 417-444.

Add three suppression rules **before** `svc.create(...)`:

1. **Length gate:** skip when trimmed text < 12 chars OR matches a curated acknowledgments list (`/^(ok|好的|收到|thx|谢谢|👍|✅|got it)\W*$/i`). Catches "好的 现在就处理吧"-class noise.
2. **Thread continuation gate:** skip when `message.thread_ts` exists AND a Request already exists for the *parent* message (lookup via `findBySourceConversationItemId(slack-${channelId}-${thread_ts})`). Trivially de-duplicates "are we still in this thread" follow-ups.
3. **File-only gate:** skip when text is exactly the `[Slack File: …]` synthetic title with no narrative. Already a non-actionable artifact today.

Each gate logs at `debug` so the suppression is auditable. Estimated daily Request count drops from ~58 to <15 based on the live data sample.

**Test:** extend `slack-orchestrator-bridge.test.ts` with three new cases (one per gate). Existing tests unchanged.

### Patch E — Defer `orc_reply` cascade-close until decomposition can land (≈50 LOC)

**File:** `backend/src/services/v3/request-sla.subscriber.ts` `maybeCloseRequest` (around line 809).

Today the cascade close suppresses when **other non-terminal sibling WIs exist** (line 791-794) — but the suppression fails open because Layers 3 + 4 prevent siblings from being linked. Patch A fixes the linking. Patch E adds a **grace window**: when `reason === 'orc_reply'` AND the Request was created in the last 60s AND no siblings linked yet, defer the close by 30s and re-check. If the orc decomposed during the window, the sibling-count gate now succeeds and the Request stays open for normal lifecycle. If not, the close proceeds as today.

```ts
// Inside maybeCloseRequest, after VERIFIED_REPLY_REASONS check, before getById:
if (reason === 'orc_reply') {
  const ageMs = Date.now() - new Date(request.createdAt).getTime();
  const linkedSiblings = (request.workItemIds ?? []).length;
  if (ageMs < ORC_REPLY_GRACE_AGE_MS && linkedSiblings === 0) {
    // Defer one re-check in 30s. If decomposition lands during the window
    // the sibling check will block the close on the second pass.
    setTimeout(() => void this.maybeCloseRequest(requestId, 'orc_reply_recheck'), ORC_REPLY_GRACE_MS).unref?.();
    return;
  }
}
```

Add `'orc_reply_recheck'` to `VERIFIED_REPLY_REASONS`. Constants: `ORC_REPLY_GRACE_AGE_MS = 60_000`, `ORC_REPLY_GRACE_MS = 30_000`.

**Test:** new test cases — (a) recheck path keeps Request open when sibling appears mid-window; (b) recheck path closes Request when no sibling appears; (c) old Request (>60s) closes immediately as today (no behavior change for legacy paths).

### Summary table

| Patch | LOC | File | Risk | Required for fix? |
|---|---|---|---|---|
| A | ~15 | `request-sla.subscriber.ts` | Low — additive call, idempotent | Yes (closes Layers 3 + 4) |
| B | ~10 | `delegate-task/execute.sh` | Low — config-only | Yes (Layer 2) |
| C | ~30 | new `orchestrator/break-down-request/` | Low — new skill | Yes (Layer 1) |
| D | ~40 | `slack-orchestrator-bridge.ts` | Medium — behavior change for spam suppression | No (compounding cleanup) |
| E | ~50 | `request-sla.subscriber.ts` | Medium — timing change | Yes (Layer 5) |
| **Total** | **~145** | | | |

Patches A + B + C + E are the **minimum required** for the symptom to clear. Patch D is bundled because it's adjacent and the dogfood data showed ≥80% of auto-Requests are non-actionable; shipping the gate now prevents the fix from drowning in noise.

**Migration / breaking-change check:** none. All changes are additive or correct existing dead code paths. Existing Requests with `workItemIds: []` remain that way (no backfill in scope; tracked separately if needed).

---

## 5. Compounding Race: `orc_reply` vs `workitem_decompose` Ordering

The race shape, in time-ordered narrative form:

```
T+0ms      User Slack message arrives at slack-orchestrator-bridge.handleSlackMessage
T+1ms      setImmediate(create Request)        ─┐ fire-and-forget, race begins
T+2ms      sendToOrchestrator(message.text)    ─┤  parallel
T+~10ms    Request.create() persists           ─┤
T+~10ms    request:created event published    ─┘
T+~12ms    request-sla.subscriber.handleRequestCreated:
              creates respond_to_user WI       ─┐
              taskPool.addToPool(wi)           ─┤
              wi:queued event                  ─┤
              starts 5min/10min SLA timers     ─┘
T+~20ms    Orc receives message in PTY (sendToOrchestrator)
T+1-180s   Orc thinks, reads prompt-builder L374, has no skill, writes plain reply
T+~Ns      reply-slack skill called → fromOrcReply=true
T+~N+5ms   sendSlackResponse → markResolvedByThread(originalMessage.ts)
T+~N+10ms  request-sla.subscriber.markResolved(requestId, 'orc_reply')
T+~N+15ms  maybeCloseRequest:
              - VERIFIED_REPLY_REASONS check ✓ (orc_reply ∈ set)
              - getById ✓
              - sibling count = 0 (Layer 3 + 4 ensure this)
              - cascade close → Request.status = done
```

**The window from `request:created` to `markResolved('orc_reply')` is the race we lose.** It's bounded by orc reply latency (1-180s in practice). Even if the orc had a working `materialize-workitems` skill and called it, the multi-step `plan → review → call break-down-request → addToPool×N → workitem:queued×N` would have to complete *and* the linkWorkItem from Patch A would have to run *before* the reply hits `markResolved`. With shell-skill latency (typically 200-500ms each), 3-5 sequential calls put us at 1-2.5s minimum — workable but flaky.

**Patch E's grace window (60s creation-age, 30s recheck) makes this race deterministic:** the orc has up to 60s after Request creation to decompose without losing the Request, and the recheck fires once at 30s after the reply. If decomposition lands within either window, the sibling-count gate catches and suppresses the close. If not, the existing behavior is preserved.

**Why Patch E is not "increase the SLA timer":** the 5min SLA is for *user-visible response* latency (so the user knows we're working on it). Decoupling the orc-reply close from the decomposition window preserves the response-SLA semantic while giving decomposition a chance.

---

## 6. Acceptance Criteria

For the fix to be considered complete, the **next 5 inbound non-trivial Slack Requests** must:

1. Have `workItemIds.length ≥ 1` within 90s of creation.
2. Stay in `running` (not `done`) until at least one delegated WorkItem completes or the orc explicitly closes.
3. Show ≥ 50% reduction in trivial auto-Request creation rate (Patch D).
4. The reference Request `739e9dca` itself remains a permanent test-fixture; we do **not** retroactively fix it (it was filed as a bug instance).

Run the dogfood acceptance harness (`scripts/dogfood-pipeline-acceptance.sh` per `.crewly/specs/2026-05-05-pipeline-dogfood-prompt-amendment.md` §5.2) end-to-end with a synthetic L2 Slack message and verify all four assertions pass.

---

## 7. Out of Scope (deferred)

- **Backfill** of existing `workItemIds: []` Requests — separate spec needed if product wants historical correctness.
- **Plan-then-confirm UX** (the orc presents the RequestPlan to the user for review before materializing) — the prompt instruction at L374 implies this but no UI affordance exists. Tier-3.
- **L3 Mission decomposition** path — different code path (`mission-executor.service.ts`), not affected by this gap.
- **Demoting `respond_to_user` WI** out of the user-facing pool view if the user dislikes the SLA tracker showing up. UX-only.

---

## 8. References

- Source: live diagnosis 2026-05-05 by Leo, dispatched by Sam (TL) per [P1 dogfood pipeline-bug] brief.
- Reference Request: `739e9dca-8507-4f19-9d2a-96ab2381822f` (`tl-sam-dogfood-pipeline-bug-2026-05-05T21:30Z`).
- Adjacent prior art: `.crewly/specs/2026-05-05-pipeline-dogfood-prompt-amendment.md` (§3.1 pipeline-first planning discipline; §5.2 acceptance harness).
- Code anchors:
  - `backend/src/services/v3/request.service.ts:151,262,324,375` (create / update / linkWorkItem / plan)
  - `backend/src/controllers/request/request.controller.ts:88,129` (createRequestHandler / planRequest)
  - `backend/src/services/v3/request-sla.subscriber.ts:294,620,698,809,1081` (VERIFIED_REPLY_REASONS / markResolvedByThread / markResolved / maybeCloseRequest / handleWorkItemQueued)
  - `backend/src/services/slack/slack-orchestrator-bridge.ts:417,1450,1476` (auto-Request setImmediate / sendSlackResponse / markResolvedByThread call)
  - `backend/src/services/v3/v3-data.service.ts:248,308` (onTaskDelegated / linkWorkItem call site)
  - `backend/src/controllers/task-management/task-management.controller.ts:275` (only `v3:task_delegated` emit site)
  - `backend/src/services/ai/prompt-builder.service.ts:367-377` (orc prompt instruction)
  - `config/skills/orchestrator/delegate-task/execute.sh:186-196` (broken `/pool/add` URL, missing requestId)
  - `config/skills/agent/core/break-down-request/execute.sh:141-184` (correct materialization, dropped `workItemIds` PUT)

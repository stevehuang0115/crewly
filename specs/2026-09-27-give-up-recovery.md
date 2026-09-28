# Give-up recovery (#841)

## Problem

A worker can stop and say a still-achievable task "can't be done". Crewly could not tell that apart from a stop that rightly needs a human (a copyright question, a login, a spending decision), so every such stop went to a lead case by case.

## Rule

Every stop a **worker** makes through the pool API is classified: `POST /task-pool/complete`, `/block` and `/fail`. System-internal calls to `completeItem` / `failItem` are not.

| Verdict | When | What happens |
|---|---|---|
| `retry` | a feasibility give-up ("can't / impossible / no way / 做不到 / 无法 / 不可能") and **no exclusion** | a new WorkItem goes back to the same worker to try a materially different approach, bounded per root |
| `escalate` | any exclusion, a dependency wait, or anything unrecognised | **no change to today's routing**; the stop is only recorded |
| `none` | a completion that is not a give-up (see below) | the completion is exactly as before |

### The classifier

`services/task-pool/give-up/stop-classifier.ts` is pure, deterministic pattern matching in English and Chinese, with no LLM. **When unsure, it escalates.** The dangerous error is a false retry, which would push an agent past a human decision.

**Exclusions** are checked first, and **always win** over a feasibility cue in the same message ("I can't, it needs your card" escalates). They are reported most-specific first:

- quota / usage / rate limits (429, "usage limit reached", 额度)
- legal / copyright / license
- safety / refusal
- personal data / privacy
- destructive or irreversible: deleting data, force-push, production deploy/release, rotating secrets
- acting on the owner's behalf externally: email, public posts, messaging customers
- money: pay, card, billing, subscription, budget
- permission / credentials / login / API keys
- owner decision / scope: "your call", "which option", "should I", `needs_alignment`, 拍板 / 等你
- environment outages: disk full, network down, 5xx, `command not found`, not installed

**Completions are narrowed**, because a finished task must never become a failure. A completion is a give-up only when **both** of these hold:

1. it has a feasibility cue as the outcome;
2. it has **no delivery evidence**: no PR/issue URL, commit SHA, findings/specs or other file path, and no success words (done / fixed / merged / verified / found / sent / … / 完成 / 已修复).

The give-up phrase is removed before checking for delivery, so "cannot be done" is not read as "done". If a completion has both a give-up cue and delivery evidence, it stays exactly as today.

### Retry (new WorkItems only)

- **ID:** `${root}:giveup:${n}`. Same target, type, requestId and missionId.
- **`parentWorkItemId` = the root's parent.** The retry sits beside the root, so a cascade-cancel of a stopped attempt can never reach it.
- **Description:** the root brief, plus "try a materially different approach": list what was tried and why each attempt failed, pick something materially different, and block (never work around) anything that needs a human. It also carries the attempt log.
- **`metadata.giveUp`** = `{ rootWorkItemId, rootParentWorkItemId, rootTitle, rootDescription, attempt, maxRetries, attempts: [{ workItemId, source, category, reason (≤2000 chars), at }] }`.
- **Bounded per ROOT.** A retry inherits `rootWorkItemId` and the attempt log, so it can never start its own count. With N = 2:

  | Stop | Result |
  |---|---|
  | 1 | retry 1 |
  | 2 | retry 2 |
  | 3 | escalation, **even if it says "impossible" again** |

- **N** = `Team.recoveryPolicy.giveUpMaxRetries` (default **2**; **0 turns it off**, and give-up completions then complete as before). The team is found from the worker's session.

### The stopped item (only edges the transition table already permits; actor `system`)

| Stopped via | Becomes |
|---|---|
| `fail` | stays `failed`, with a `succeeded_by` disposition, so `detectRetryableFailedWorkItems` does not also requeue it in place |
| `block` | `blocked → cancelled`, reason `superseded by <successor>` |
| `complete` (give-up outcome) | `running → failed` with the summary as the error, then as `fail`; no `done_by_worker`, so the lead gets no verify ping per attempt |

Nothing verified or terminal is reopened or rewritten.

### One escalation to the lead

- After N, **one** review WorkItem `${root}:review:gave_up`. It is idempotent by id: `addToPool` skips a duplicate.
- **Type and target:** `type: review`, `owner: team_lead`, `metadata.reviewReason: 'gave_up'`.
- **Content:** the full attempt history in `metadata.giveUp` and in the description.
- **Target resolution:** the worker's team lead. If there is none, or the lead is the worker, it goes to the orchestrator.
- **The review's dispatch is the single ping.** Stops that need a human keep today's routing.

### Recorded on every classified stop

`metadata.stop` = `{ source, decision, category, rules[], reason (≤2000), at }`. This is best-effort: a failure to annotate never turns a successful stop into an API error.

### Metrics

`GET /api/task-pool/give-up-stats[?teamId=]` is computed from the pool on demand (nothing extra is stored). It returns `{ examined, teams: [...] }` with these per-team counts:

| Field | Meaning |
|---|---|
| `giveUps` | stops classified as a feasibility give-up |
| `retries` | retry WorkItems queued |
| `retriesSucceeded` | retries that reached `done` / `verified` |
| `retriesFailed` | retries that ended `failed` / `rejected` / `cancelled` |
| `retriesPending` | retries not finished yet |
| `retrySuccessRate` | succeeded ÷ finished, or null |
| `escalations` | give-up reviews sent to a lead |
| `escalatedByCategory` | human-needed stops, by category |

## Fixtures

`services/task-pool/give-up/__fixtures__/stop-messages.json` holds 56 stop messages: 35 real (scrubbed) and 21 synthetic (labelled).

**Real sources:** the task pool's completion summaries and blocked reasons, `chat.db` agent messages (2,065 examined), and the message-queue `[BLOCKED]` history. One of them is the 2026-09-27 copyrighted-sermon `BLOCKED (needs_alignment)`.

| Set | Count | Real | Expected |
|---|---|---|---|
| Needs a human | 33 | 20 | escalate |
| Delivered completions mentioning can't/couldn't/无法 | 14 | 14 | none |
| Give-ups | 9 | — | retry |

The 20 real needs-a-human stops cover credentials, copyright, pricing and scope decisions, production changes, and a usage limit. The 13 synthetic ones are adversarial: each has a give-up cue and an exclusion.

The give-ups are **only 1 real** (the #841 example) and 8 synthetic. Real feasibility give-ups are scarce in our data.

The test prints N examined, false-retry (must be 0), false-conversion (must be 0) and false-escalate. It refuses to pass with fewer than 15 real needs-a-human or 10 real delivered completions.

## Not in v1 (#842)

- `report-status blocked|failed`, which leaves the WorkItem running.
- Idle with a running WorkItem.
- The unpublished `task:blocked` / `task:failed` events.

Stops that fail for an excluded reason keep today's handling, including the reconciler's in-place retry of `failed` items.

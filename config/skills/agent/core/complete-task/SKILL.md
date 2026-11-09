---
name: Complete Task
description: Mark a task as complete with a summary and evidence (artifacts that exist, commands with exit codes), or report it blocked.
version: 1.3.0
category: task-management
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
triggers:
  - complete task
  - finish task
  - mark done
  - task done
tags:
  - task
  - completion
  - status
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Complete Task

Mark a task as complete with a summary of the work done. If the task has an output schema, provide structured output that will be validated against the schema. Unknown fields are refused, never silently dropped.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workItemId` | Preferred | ID of the V3 WorkItem to complete. This is the only input that selects the WorkItem |
| `sessionName` | Yes | Your agent session name |
| `summary` | Yes | Summary of the work completed |
| `evidence` | Yes* | Array of evidence entries — see **Evidence contract** below. *Required: refused without it (400 `evidence_required`), except a review `verdict` |
| `absoluteTaskPath` | No | **Legacy (V1).** Still accepted so older callers keep working, but it does NOT identify a WorkItem |
| `output` | No | Structured output object (required if task has an output schema) |
| `decisions` | No | Array of short strings: the key decisions you made — see **Decision record** below |
| `notTaken` | No | Array of short strings: options you considered and did not take, each with the reason |
| `assumptions` | No | Array of short strings: what you relied on without checking |
| `taskKind` | No | What kind of task this was (`revision`, `new-build`, `new-capability`, `research`, `review`, or your own kebab-case word). Used for task timing; without it the kind named in `report-progress`, then the title, decides |
| ~~`skipGates`~~ | **Rejected** | **Not supported.** This endpoint runs no quality gates, so there is nothing to skip. Passing it is a hard error. Use the `check-quality-gates` skill for gates. |

**Any other field is an error.** The skill accepts only the fields in this table plus `verdict`/`feedback`/`checks` (reviews) and `taskId`/`artifacts`/`testResults`/`structured` (verification requests). An unknown field (for example `projectPath`, `skipGates`, `force`) stops the call before anything is sent, and the error names the field. Put extra results inside `output`.

On success the skill prints **one JSON line** that always names the `workItemId`, plus the server's reply (`success`, `message`, any `warning`, and `timing`).

`timing` is how long this task took from claim to completion, against your ETA and your own median for that kind, e.g. `This was a 'revision'. You estimated 60 min; it took 18 min. Your median for 'revision' is 23 min (n=12).` When the gap is over 1.5x it asks you to record a learning (`record-learning`) if you see why. The record is kept automatically; you do not need to do anything else.

### Which WorkItem gets completed

Resolution order:

1. `workItemId`, if you pass it — always wins.
2. Otherwise, ONLY when you named no task (no `workItemId`, no `taskId`): a lookup of the WorkItem currently `running` against your
   `sessionName` (`GET /api/task-pool/items?status=running&target=<session>`).
   It is used only when exactly ONE item is running. With several, the skill
   refuses (non-zero exit) and lists their ids: pass `workItemId` with one.
3. If you passed `taskId` without `workItemId`, the skill
   refuses (non-zero exit): it never substitutes your running item for an id you named.
4. If nothing resolves, the skill exits non-zero with an error naming the
   session it searched. It never reports success without completing something.

Pass `workItemId` whenever you know it — the lookup in step 2 depends on the
pool state at that instant, and with two running items it refuses rather
than guess.

## Evidence contract (#873)

"Done" needs evidence. Send `evidence` as an array; each entry is one of:

| Entry | Fields | Server check |
|-------|--------|--------------|
| `{"type":"artifact","path":"…"}` | Absolute path, path relative to your worktree/project, or an `https://` URL | A local path must exist, else 400 |
| `{"type":"command","command":"…","exitCode":0,"outputTail":"…"}` | The command, its exit code, the last lines of its output | `exitCode` must be 0, else 400 — a failing command is not evidence of done |
| `{"type":"blocked","step":"…","reason":"…"}` | The step that failed and why | The WorkItem is recorded as **blocked**, not done |

If you could not finish, do **not** report done: send a `blocked` entry (or use
`report-status --status blocked`). Malformed evidence is rejected with 400
naming the bad entry. A completion with no evidence is refused with 400
`evidence_required` and nothing is completed (#1312).
A review verdict (`verdict` set) needs no evidence.

## Decision record (#875)

Evidence shows the work exists; the record shows how you got there. Send any
of `decisions`, `notTaken`, `assumptions` as arrays of short strings (one
sentence each). The reviewer sees them in the Verify item under "Worker's
record" and checks that they hold — a wrong assumption or a road not taken
for a bad reason is a reason to send the work back, even when every test
passes. Leave a field out when there is nothing to say; an empty list is fine.

```json
"decisions":["Kept the v1 schema; the new field goes in metadata"],
"notTaken":["A new table — needs a migration the owner has not approved"],
"assumptions":["The relay runs 1.5.24 in production (checked the compose file, not the container)"]
```

## Example

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"workItemId":"wi-abc123","sessionName":"dev-1","summary":"Implemented login form with validation and tests","evidence":[{"type":"artifact","path":"src/login.tsx"},{"type":"command","command":"npx jest src/login.test.tsx","exitCode":0,"outputTail":"Tests: 6 passed, 6 total"}]}'
```

### Could not finish

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"workItemId":"wi-abc123","sessionName":"dev-1","summary":"Login form done; e2e blocked","evidence":[{"type":"blocked","step":"npx playwright test","reason":"staging auth server returns 503"}]}'
```

If the task is not finished because it can only proceed at a known time (a
data window that has not closed, a deploy that has to settle), do not complete
it: block it with the `block-task` skill and its `until` parameter. The item
comes back to you when the time has passed.

### Letting the skill resolve your running WorkItem

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"sessionName":"dev-1","summary":"Implemented login form with validation and tests"}'
```

### With structured output

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"workItemId":"wi-abc123","sessionName":"dev-1","summary":"Implemented login","output":{"summary":"Login form with validation","filesChanged":["src/login.tsx","src/login.test.tsx"],"testsAdded":2}}'
```

Note: a `summary` key inside `output` overrides the top-level `summary`.

### Legacy V1 caller (still supported)

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"absoluteTaskPath":"<old task path>","sessionName":"dev-1","summary":"Implemented login"}'
```

`absoluteTaskPath` is carried for logging context only; the WorkItem is still
resolved by step 2 above.

## Output Schema

If the task markdown contains an `## Output Schema` section with a JSON Schema definition, your `output` object must validate against that schema. If validation fails, the response will include the errors and you can retry (up to 2 retries). After max retries, the task will be moved to blocked/.

## Pre-Completion Checklist

Before calling this skill, verify:

1. **All requirements met** — re-read the original task and confirm every requirement is addressed
2. **Code tested** — if you wrote code, run the relevant tests, confirm they pass, and put the command and its exit code in `evidence`
3. **URLs verified** — if your output includes URLs or links, verify they are valid
4. **Sources cited** — for research tasks, ensure all factual claims have source references
5. **Summary accurate** — your summary should reflect what was actually done, not just what was planned

## Output

JSON confirmation of task completion status. If validation fails:
```json
{
  "success": false,
  "validationFailed": true,
  "errors": ["error details"],
  "retryCount": 1,
  "maxRetries": 2,
  "message": "Output validation failed. 1 retries remaining."
}
```

## Reviewing someone else's work (`Verify: …` items)

When the item you're completing is a review of another agent's work:

- **Accept:** open or re-run the worker's evidence (the item lists it numbered; `verify-output` shows it in full) and send `"verdict":"verified"` with `"checks"`: one `{"entry":<index>,"did":"<what you did and saw>","outcome":"pass"}` per entry you checked, `"entry":null` for a direct look at the work. At least one check must name a worker evidence entry when there is any. An accept without checks, or with a `"fail"` check, is refused (400 `review_unchecked` / `review_check_failed`) and nothing is accepted.
- **Send it back:** add `"verdict":"rejected"` and `"feedback":"<what is wrong>"`. The worker gets a retry that includes your feedback. Feedback is required when you reject.

```bash
bash execute.sh '{"workItemId":"<verify item id>","sessionName":"<you>","summary":"Export is right","verdict":"verified","checks":[{"entry":0,"did":"opened export.csv: 120 rows, header present","outcome":"pass"},{"entry":1,"did":"re-ran npm test: exit 0","outcome":"pass"}]}'
bash execute.sh '{"workItemId":"<verify item id>","sessionName":"<you>","summary":"Header row missing","verdict":"rejected","feedback":"Add the header row and re-run the export"}'
```

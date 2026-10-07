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
| `evidence` | Yes* | Array of evidence entries — see **Evidence contract** below. *Accepted without it this release (with a warning); required from the next release |
| `absoluteTaskPath` | No | **Legacy (V1).** Still accepted so older callers keep working, but it does NOT identify a WorkItem |
| `output` | No | Structured output object (required if task has an output schema) |
| ~~`skipGates`~~ | **Rejected** | **Not supported.** This endpoint runs no quality gates, so there is nothing to skip. Passing it is a hard error. Use the `check-quality-gates` skill for gates. |

**Any other field is an error.** The skill accepts only the fields in this table plus `verdict`/`feedback` (reviews) and `taskId`/`artifacts`/`testResults`/`structured` (verification requests). An unknown field (for example `projectPath`, `skipGates`, `force`) stops the call before anything is sent, and the error names the field. Put extra results inside `output`.

On success the skill prints **one JSON line** that always names the `workItemId`, plus the server's reply (`success`, `message`, any `warning`).

### Which WorkItem gets completed

Resolution order:

1. `workItemId`, if you pass it — always wins.
2. Otherwise, a lookup of the WorkItem currently `running` against your
   `sessionName` (`GET /api/task-pool/items?status=running&target=<session>`).
3. If neither resolves, the skill exits non-zero with an error naming the
   session it searched. It never reports success without completing something.

Pass `workItemId` whenever you know it — the lookup in step 2 depends on the
pool state at that instant and cannot disambiguate two concurrently running
items for one session.

## Evidence contract (#873)

"Done" needs evidence. Send `evidence` as an array; each entry is one of:

| Entry | Fields | Server check |
|-------|--------|--------------|
| `{"type":"artifact","path":"…"}` | Absolute path, path relative to your worktree/project, or an `https://` URL | A local path must exist, else 400 |
| `{"type":"command","command":"…","exitCode":0,"outputTail":"…"}` | The command, its exit code, the last lines of its output | `exitCode` must be 0, else 400 — a failing command is not evidence of done |
| `{"type":"blocked","step":"…","reason":"…"}` | The step that failed and why | The WorkItem is recorded as **blocked**, not done |

If you could not finish, do **not** report done: send a `blocked` entry (or use
`report-status --status blocked`). Malformed evidence is rejected with 400
naming the bad entry. A completion with no evidence is accepted this release
but the response (and stderr) carries a `warning`; next release it is a 400.
A review verdict (`verdict` set) needs no evidence.

## Example

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"workItemId":"wi-abc123","sessionName":"dev-1","summary":"Implemented login form with validation and tests","evidence":[{"type":"artifact","path":"src/login.tsx"},{"type":"command","command":"npx jest src/login.test.tsx","exitCode":0,"outputTail":"Tests: 6 passed, 6 total"}]}'
```

### Could not finish

```bash
bash config/skills/agent/core/complete-task/execute.sh '{"workItemId":"wi-abc123","sessionName":"dev-1","summary":"Login form done; e2e blocked","evidence":[{"type":"blocked","step":"npx playwright test","reason":"staging auth server returns 503"}]}'
```

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

- **Accept:** complete it normally with a summary.
- **Send it back:** add `"verdict":"rejected"` and `"feedback":"<what is wrong>"`. The worker gets a retry that includes your feedback. Feedback is required when you reject.

```bash
bash execute.sh '{"workItemId":"<verify item id>","sessionName":"<you>","summary":"Header row missing","verdict":"rejected","feedback":"Add the header row and re-run the export"}'
```

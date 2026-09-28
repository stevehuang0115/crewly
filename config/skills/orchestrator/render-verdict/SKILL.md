---
name: Render Verdict
description: Record a review verdict (verified/rejected) on a done_by_worker WorkItem, with the caller's identity attached so the backend accepts it.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - render verdict
  - verify workitem
  - reject workitem
  - verdict needed
tags:
  - task-pool
  - verification
  - escalation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Render Verdict

Record an explicit review verdict on a `done_by_worker` WorkItem — the step
the escalation chain (#813/#819) asks the orchestrator to take once a
worker's completion has gone unverified by its Team Leader for too long.

## Why not `curl` directly?

`POST /api/task-pool/items/:id/verdict` identifies its caller from the
`X-Agent-Session` request header (never from the request body — see
`resolveTransitionActor` in `backend/src/utils/agent-caller.utils.ts`). A raw
`curl` sends no such header, so the backend cannot tell who is calling and
refuses with `403 { code: "transition_not_reviewer" }`. This skill runs the
same POST through `api_call` (`config/skills/_common/lib.sh`), which always
attaches `X-Agent-Session: $CREWLY_SESSION_NAME` — run it with
`CREWLY_SESSION_NAME` set to your own session (`crewly-orc` for the
orchestrator) and the backend recognizes the caller correctly.

## Usage

```bash
CREWLY_SESSION_NAME=crewly-orc bash config/skills/orchestrator/render-verdict/execute.sh \
  '{"workItemId":"abc-123","verdict":"verified","comment":"Meets the acceptance criteria"}'
```

## Parameters

- `workItemId` (required, alias `taskId`) — the `done_by_worker` WorkItem to verdict.
- `verdict` (required) — `"verified"` or `"rejected"`.
- `comment` (optional) — reviewer's note; required in practice for a rejection so the worker knows what to fix.

## Output

The raw JSON response of `POST /api/task-pool/items/:workItemId/verdict`:
`{"success":true,"data":<WorkItem>}` on success, or a JSON error object on
stderr (400 invalid verdict, 403 not the reviewer, 404 not found, 409 not
`done_by_worker`).

---
name: Handle Failure
description: "Decide the next action when a worker task fails verification or execution: retry the same worker, reassign to another worker, or escalate to the Orchestrator."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - handle failure
  - task failed
  - worker error
  - decide next action
tags:
  - failure
  - recovery
  - retry
  - escalation
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Handle Failure

Decides the next action when a worker task fails verification or execution. Implements a three-tier decision logic: retry, reassign, or escalate.

## When to Use

- When `verify-output` returns `passed: false`
- When a worker reports a `blocked` status
- When a worker session crashes or becomes unresponsive

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/handle-failure/execute.sh '{"workerId":"worker-1","workerSession":"worker-session","teamId":"team-123","failureInfo":{"error":"3 tests failed","failedSteps":["tests"],"retries":0,"failureType":"verification"},"requiredRole":"developer"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workerId` | Yes | ID of the failed worker |
| `workerSession` | No | Session name of the failed worker |
| `teamId` | No | Team ID (needed for reassignment lookup) |
| `requiredRole` | No | Role required for the task (helps find alternatives) |
| `taskDescription` | No | Brief task description for context |
| `projectPath` | No | Project root; with `failureInfo.correctionClass`, the failure is counted on the project's correction ladder (#810) |
| `failureInfo` | Yes | Failure details object (see below) |

### failureInfo Object

| Field | Description |
|-------|-------------|
| `error` | Error message or description |
| `failedSteps` | Array of failed verification step names |
| `retries` | Number of retries already attempted |
| `failureType` | Category of failure (see below) |
| `correctionClass` | Optional. A short slug for the *kind* of mistake behind the failure (`skip-tests-before-pr`, `git-add-all`). Give one when the failure was a correction of how the worker works, not a flaky environment. The second time a class is recorded in a project you (the lead) get one WorkItem asking whether it can be made impossible, caught by a check or a hook, or must stay prose — answered with `decide-correction`. The output carries `correction: { class, count, raised }`. |

### Failure Types

| Type | Description | Default Action |
|------|-------------|----------------|
| `verification` | Verification checks failed | Retry (< 2 retries) |
| `format` | Output format issues | Retry |
| `test_failure` | Tests failed | Retry |
| `pty_error` | PTY session error | Retry |
| `session_error` | Session crashed | Retry |
| `skill_mismatch` | Worker lacks required skills | Reassign |
| `resource_error` | Resource unavailable | Escalate |
| `permission_error` | Permission denied | Escalate |
| `budget_error` | Token/API budget exceeded | Escalate |

## Decision Logic

```
1. retries < 2 AND recoverable failure → RETRY
   (verification, format, test_failure, pty_error, session_error, unknown)

2. retries >= 2 OR skill_mismatch → REASSIGN
   - Searches team for another active worker with matching role
   - If no alternative found → ESCALATE

3. resource/permission/budget error → ESCALATE immediately
   (These cannot be resolved at the TL level)
```

## Output

```json
{
  "action": "retry",
  "nextWorkerId": null,
  "nextWorkerSession": null,
  "instructions": "Retry attempt 1/2. Previous failure: 3 tests failed. Please fix the issues and try again.",
  "context": {
    "originalWorkerId": "worker-1",
    "failureType": "verification",
    "retriesSoFar": 0
  }
}
```

## After Getting the Decision

| Action | Next Step |
|--------|-----------|
| `retry` | Send instructions to the original worker via `delegate-task` with incremented retry count |
| `reassign` | Use `delegate-task` to send the task to `nextWorkerId`/`nextWorkerSession` |
| `escalate` | Report to Orchestrator via `report-status` with the failure details |

## Related Skills

- `verify-output` — Triggers handle-failure when verification fails
- `delegate-task` — Used for retry and reassign actions
- `aggregate-results` — Include failure handling in reports

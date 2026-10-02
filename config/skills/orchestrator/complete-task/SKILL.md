---
name: Complete Task
description: Mark a WorkItem complete in the V3 task pool, with evidence.
version: 1.1.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - complete task
  - finish task
  - task done
tags:
  - task
  - completion
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Complete Task

Mark a WorkItem complete via `POST /api/task-pool/complete/:id`.

## Usage

```bash
bash config/skills/orchestrator/complete-task/execute.sh '{"workItemId":"wi-123","summary":"Shipped the report","evidence":[{"type":"artifact","path":"/abs/path/report.md"},{"type":"command","command":"npm test","exitCode":0}]}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workItemId` (alias `taskId`) | Yes | The WorkItem to complete |
| `summary` (alias `result`) | Yes | What was produced |
| `evidence` | Yes* | Evidence array (#873): `{"type":"artifact","path":…}` (must exist, or an https URL), `{"type":"command","command":…,"exitCode":0,"outputTail":…}`, or `{"type":"blocked","step":…,"reason":…}` (records the item as blocked, not done). *Accepted without it this release with a `warning`; required from the next |
| `output` | No | Structured output stored on the WorkItem before completion |
| `agentId` / `sessionName` | No | Who completed it (defaults to `crewly-orc`) |

## Output

The server's JSON response. A `warning` from the server (completion without
evidence) is repeated on stderr.

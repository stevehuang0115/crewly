---
name: Design Checklist
description: "Generate an acceptance checklist for a delegated objective BEFORE execution begins. The checklist must be sent to and approved by the superior (Orchestrator/user) to ensure alignment. Once approved, it becomes the verification standard used by verify-output after task completion."
version: 1.0.0
category: quality
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - design checklist
  - create acceptance criteria
  - define verification checklist
  - alignment checklist
tags:
  - checklist
  - quality
  - alignment
  - verification
  - planning
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Design Checklist

Generates a structured acceptance checklist for a task/objective **before execution begins**.
The checklist is sent to the Orchestrator (or user) for alignment and approval.
Once approved, the TL uses it during `verify-output` after workers complete the task.

## Flow

```
1. TL receives objective from Orchestrator
2. TL runs design-checklist → generates checklist.json
3. Checklist sent to Orchestrator for approval
4. Orchestrator approves/adjusts → POST /api/task-management/:taskId/checklist/approve
5. TL proceeds with decompose-goal + delegate-task
6. Workers complete → TL runs verify-output with approved checklist
```

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/design-checklist/execute.sh \
  --objective "Build user authentication" \
  --project-path /path/to/project \
  --task-id task-123 \
  [--team-id team-456] \
  [--mission-id mission-789]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--objective` | Yes | The objective/task to design acceptance criteria for |
| `--project-path` | Yes | Project root path |
| `--task-id` | Yes | Task ID for storing the checklist |
| `--team-id` | No | Team ID (loads template verification pipeline as baseline) |
| `--mission-id` | No | Mission ID (loads Mission.successCriteria for alignment) |

## Output

The skill outputs context for the runtime to generate a checklist, then stores it:

```json
{
  "success": true,
  "taskId": "task-123",
  "checklistPath": "/project/.crewly/tasks/.../checklist.json",
  "status": "pending_approval",
  "itemCount": 5
}
```

## Checklist Format

```json
{
  "taskId": "task-123",
  "objective": "Build user authentication",
  "status": "pending_approval",
  "createdBy": "tl-session-name",
  "createdAt": "ISO8601",
  "alignedWith": "mission-success-criteria (if available)",
  "items": [
    {
      "id": "chk-1",
      "category": "functionality",
      "description": "JWT token generation and validation works correctly",
      "type": "command",
      "command": "npm test -- --grep 'jwt'",
      "critical": true
    },
    {
      "id": "chk-2",
      "category": "quality",
      "description": "Test coverage above 80%",
      "type": "command",
      "command": "npm test -- --coverage",
      "critical": true
    },
    {
      "id": "chk-3",
      "category": "review",
      "description": "Code follows project patterns and has proper error handling",
      "type": "manual",
      "critical": false
    }
  ]
}
```

## Related Skills

- `decompose-goal` — Break objective into subtasks (run AFTER checklist approved)
- `verify-output` — Use approved checklist to verify completed work
- `delegate-task` — Assign subtasks to workers

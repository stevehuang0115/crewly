---
name: Score Task
description: "Score a completed task's quality (0-100) for tracking per-agent quality metrics."
version: 1.0.0
category: quality
skillType: claude-skill
assignableRoles:
  - auditor
triggers:
  - score task
  - quality score
  - rate task
tags:
  - quality
  - audit
  - metrics
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Score Task

Assigns a quality score (0-100) to a completed task for per-agent quality tracking.

## Usage

```bash
bash config/skills/auditor/score-task/execute.sh '{"taskId":"task-123","qualityScore":85}'
```

## Parameters

- `taskId` (required): ID of the completed task to score
- `qualityScore` (required): Quality score between 0 and 100
- `sessionName` (optional): Session name of the scorer (defaults to "auditor")

## Output

JSON response confirming the score was recorded.

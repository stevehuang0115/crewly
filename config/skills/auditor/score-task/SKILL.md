---
name: Score Task
description: "Score a completed task's quality (0-100) for tracking per-agent quality metrics."
triggers:
  - score task
  - quality score
  - rate task
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

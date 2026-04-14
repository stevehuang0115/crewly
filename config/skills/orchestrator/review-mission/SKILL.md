---
name: Review Mission OKR
description: Execute an OKR review cycle — aggregate KR + task progress, reason about strategy effectiveness, and submit a review decision (continue, adjust, replan, or cancel).
version: 1.0.0
category: planning
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - review mission
  - okr review
  - check mission progress
  - mission review
tags:
  - mission
  - okr
  - review
  - autonomous
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Review Mission OKR

Executes a periodic OKR review for a Mission. Aggregates Key Result progress
and task completion data, then asks the runtime to reason about whether the
current strategy is effective and what action to take next.

## Usage

```bash
bash config/skills/orchestrator/review-mission/execute.sh \
  --mission-id <uuid> \
  --project-path /path/to/project
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--mission-id` | Yes | UUID of the Mission to review |
| `--project-path` | Yes | Absolute path to the project root |

## Review Decision Output

The runtime should produce a JSON ReviewDecision:

```json
{
  "action": "continue | adjust_strategy | replan_phase | add_tasks | cancel_mission",
  "newStrategy": "Updated strategy text (if adjusting)",
  "learnings": ["What we learned from this review cycle"],
  "krUpdates": [{"krId": "...", "newTarget": 150, "note": "Revised after measurement"}]
}
```

The skill submits this to `POST /api/missions/:id/review-decision`.

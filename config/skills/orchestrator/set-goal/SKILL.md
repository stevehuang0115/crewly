---
name: Set Goal
description: Set a project-level goal to guide team priorities and track progress, or mark one reached, superseded or cancelled.
version: 1.1.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - set goal
  - add goal
  - new goal
  - project goal
  - goal reached
  - goal met
tags:
  - memory
  - goals
  - planning
  - project
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Set Goal

Set a project-level goal to guide team priorities and track progress. The
goals log (`<project>/.crewly/goals/goals.md`) is append-only: to close a
goal, append an entry with a `status` instead of editing the old one.

## Usage

```bash
bash config/skills/orchestrator/set-goal/execute.sh '{"goal":"Complete API integration by end of sprint","projectPath":"/path/to/project","setBy":"orchestrator"}'

# The goal was met: say which one, then the evidence as "- " lines. The team
# lead's next daily retro reviews it as a milestone.
bash config/skills/orchestrator/set-goal/execute.sh '{"goal":"Complete API integration by end of sprint\n- all 6 endpoints live since 10/24\n- contract tests green","projectPath":"/path/to/project","setBy":"orchestrator","status":"reached"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `goal` | Yes | The goal description (with a closing `status`: the goal that was reached or retired, one line, then optional `- ` evidence lines) |
| `projectPath` | No | Path to the project this goal applies to |
| `setBy` | No | Who is setting the goal (e.g., "orchestrator") |
| `status` | No | `reached` (goal met → retro milestone), `superseded`, `cancelled`, or `active` (default when absent). Any other word is rejected. |

## Output

JSON confirmation with the stored goal entry.

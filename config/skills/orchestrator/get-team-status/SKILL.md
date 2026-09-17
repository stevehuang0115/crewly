---
name: Get Team Status
description: Get current status of all teams and their agents, including who is active/inactive.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - team status
  - list teams
  - who is active
tags:
  - team
  - status
  - monitoring
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Team Status

Returns the current status of all teams and their member agents.

## Usage

```bash
bash config/skills/orchestrator/get-team-status/execute.sh
```

## Parameters

None required. Output is **compact by default** (team id/name/projectIds and
each member's name, sessionName, role, runtimeType, agentStatus,
workingStatus, readyAt). Pass `--full` (or `'{"full":true}'`) for the raw
`/teams` payload including system prompts — it is large, so only ask for it
when you need a specific field.

## Output

JSON array of teams with members and their statuses (active/inactive, idle/in_progress).

Each team may include a `mission` field (string) describing the team's purpose, plus optional `budget` and `qualityGate` configuration (#173).

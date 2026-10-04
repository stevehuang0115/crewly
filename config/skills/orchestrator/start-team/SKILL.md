---
name: Start Team
description: Start all agents in a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - start team
  - activate team
  - boot team
tags:
  - team
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Start Team

Starts all agents in a team.

## Usage

```bash
bash config/skills/orchestrator/start-team/execute.sh '{"teamId":"abc-123-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `projectId` | No | Project UUID to assign before starting (uses team's current project if omitted) |

## Output

JSON confirmation with team startup status.

## Paused teams

The owner can pause a team temporarily (specs/2026-10-04-team-pause.md). A
paused team is hidden from agents and takes no work: handing it work, or
messaging, starting or assigning a ticket to one of its members, fails with
`code: "team_paused"` and a message saying what to do instead — usually
`gh issue create -R <repo> --title "…" --body "…"` (the team's issue repo),
otherwise tell the orc. Do that; do not retry or route around the pause.

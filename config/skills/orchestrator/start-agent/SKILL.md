---
name: Start Agent
description: Start a specific agent within a team.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - start agent
  - activate agent
  - boot agent
tags:
  - agent
  - management
  - lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Start Agent

Starts a specific agent within a team.

## Usage

```bash
bash config/skills/orchestrator/start-agent/execute.sh '{"teamId":"team-uuid","memberId":"member-uuid"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `memberId` | Yes | The member's UUID within the team |

## Output

JSON confirmation with agent startup status.

## Paused teams

The owner can pause a team temporarily (specs/2026-10-04-team-pause.md). A
paused team is hidden from agents and takes no work: handing it work, or
messaging, starting or assigning a ticket to one of its members, fails with
`code: "team_paused"` and a message saying what to do instead — usually
`gh issue create -R <repo> --title "…" --body "…"` (the team's issue repo),
otherwise tell the orc. Do that; do not retry or route around the pause.

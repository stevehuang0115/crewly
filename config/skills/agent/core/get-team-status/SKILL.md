---
name: Get Team Status
description: Get the current status of all teams and their members.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
triggers:
  - team status
  - who is online
  - check team
  - team members
tags:
  - monitoring
  - team
  - status
  - agents
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Team Status

Get the current status of all teams and their members. Returns team names, member roles, agent statuses, and working statuses.

## Parameters

No parameters required.

## Example

```bash
bash config/skills/agent/get-team-status/execute.sh '{}'
```

## Output

JSON with team data including each team's members, their roles, agent status (active/inactive), and current working status (idle/in_progress).

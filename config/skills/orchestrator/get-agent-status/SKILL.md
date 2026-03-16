---
name: Get Agent Status
description: Check the current status of a specific agent by session name.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - agent status
  - check agent
  - is agent active
tags:
  - agent
  - status
  - monitoring
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Agent Status

Returns the current status of a specific agent.

## Usage

```bash
bash config/skills/orchestrator/get-agent-status/execute.sh '{"sessionName":"agent-joe"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The agent's PTY session name |

## Output

JSON object with the agent's status, role, working status, and team membership.

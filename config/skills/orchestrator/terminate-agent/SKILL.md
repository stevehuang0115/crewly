---
name: Terminate Agent
description: "Terminate an agent's terminal session completely."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - terminate agent
  - kill session
  - destroy agent
tags:
  - agent
  - termination
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Terminate Agent

Terminate an agent's terminal session completely. Use with caution.

## Usage

```bash
bash config/skills/orchestrator/terminate-agent/execute.sh '{"sessionName":"agent-joe"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The agent's PTY session name to terminate |

## Output

JSON confirmation of session termination.

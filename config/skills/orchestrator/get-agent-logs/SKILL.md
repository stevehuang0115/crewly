---
name: Get Agent Logs
description: "Get recent terminal output from an agent's PTY session."
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - agent logs
  - check output
  - terminal output
tags:
  - agent
  - logs
  - monitoring
  - terminal
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Agent Logs

Retrieves recent terminal output from an agent's PTY session.

## Usage

```bash
bash config/skills/orchestrator/get-agent-logs/execute.sh '{"sessionName":"agent-joe","lines":100}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The agent's PTY session name |
| `lines` | No | Number of lines to retrieve (default: 50) |

## Output

JSON with the agent's recent terminal output.

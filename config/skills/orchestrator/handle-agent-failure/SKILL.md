---
name: Handle Agent Failure
description: Notify the orchestrator when an agent fails or becomes inactive unexpectedly, so recovery actions can be taken.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - agent failed
  - agent crashed
  - agent inactive
  - handle failure
  - recovery
tags:
  - monitoring
  - failure
  - recovery
  - agent-lifecycle
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Handle Agent Failure

Sends a failure notification to the orchestrator when an agent becomes inactive unexpectedly (runtime exit, API failure, crash). The orchestrator can then decide to restart the agent, reassign the task, or inform the user.

## Usage

```bash
bash config/skills/orchestrator/handle-agent-failure/execute.sh '{"agentSession":"agent-dev-1","reason":"runtime_exited","hadActiveTasks":true,"taskSummary":"Implementing login form","restartAttempted":true,"restartSucceeded":false}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentSession` | Yes | The failed agent's PTY session name |
| `reason` | Yes | Failure reason: `runtime_exited`, `api_failure`, `connectivity_stuck`, `update_interrupted` |
| `hadActiveTasks` | No | Whether the agent had in-progress tasks (default: false) |
| `taskSummary` | No | Brief description of what the agent was working on |
| `restartAttempted` | No | Whether an automatic restart was attempted |
| `restartSucceeded` | No | Whether the automatic restart succeeded |

## Behavior

The script sends a structured failure notification to the orchestrator via the chat API. The orchestrator receives the message and can:

1. **Restart the agent** if the failure was transient
2. **Reassign the task** to another available agent
3. **Notify the user** about the failure and ask for guidance
4. **Record the failure** for future prevention

---
name: Send Message
description: "Readiness-aware message delivery to an agent's terminal session via /terminal/{session}/deliver. Distinct from agent/core/send-message which uses /terminal/{session}/write."
version: 1.1.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - send message
  - tell agent
  - message agent
  - deliver message
tags:
  - communication
  - agent
  - message
  - readiness-aware
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Message (orchestrator — readiness-aware delivery)

Delivers a text message to an agent's terminal session via the
**`POST /terminal/{session}/deliver`** endpoint.

## When to use this vs `agent/core/send-message`

| | `orchestrator/send-message` | `agent/core/send-message` |
|---|---|---|
| Endpoint | `POST /terminal/{id}/deliver` | `POST /terminal/{id}/write` |
| Readiness gate | Yes — waits up to `waitTimeout` ms (default 120 s) for the agent prompt | No — direct PTY write, fires immediately |
| Force override | Yes — `force: true` skips the readiness wait | n/a |
| Typical caller | Orchestrator dispatching new work to an agent that may currently be busy | Any agent that just wants to drop a line into another session's PTY |

Prefer this skill when the orchestrator needs the message to land **at**
the agent's prompt rather than mid-token. Use `agent/core/send-message`
for fire-and-forget cross-agent comms.

## Usage

```bash
# Default: wait up to 120 s for the agent to be ready, then deliver
bash config/skills/orchestrator/send-message/execute.sh \
  '{"sessionName":"agent-joe","message":"Please review the PR"}'

# Force: write immediately even if the agent is busy mid-token
bash config/skills/orchestrator/send-message/execute.sh \
  '{"sessionName":"agent-joe","message":"URGENT: stop","force":true}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The target agent's PTY session name |
| `message` | Yes | The message text to deliver |
| `force` | No | When `true`, write directly to PTY without waiting for the agent prompt. Defaults to `false` (wait for ready). |

## Output

JSON confirmation of delivery from the deliver endpoint.

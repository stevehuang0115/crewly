---
name: Send Message
description: "Send a text message to an agent's terminal session."
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - send message
  - tell agent
  - message agent
tags:
  - communication
  - agent
  - message
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Message

Sends a text message to an agent's terminal session.

## Usage

```bash
bash config/skills/orchestrator/send-message/execute.sh '{"sessionName":"agent-joe","message":"Please review the PR"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The target agent's PTY session name |
| `message` | Yes | The message text to send |

## Output

JSON confirmation of delivery.

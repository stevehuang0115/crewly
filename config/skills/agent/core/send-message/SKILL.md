---
name: Send Message
description: "Send a direct message to another agent's terminal session."
version: 1.0.0
category: communication
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
  - send message
  - message agent
  - tell agent
  - dm agent
tags:
  - communication
  - agent
  - message
  - terminal
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Message

Send a direct message to another agent's terminal session. The message is written to the target agent's PTY using the two-step message mode for reliable delivery.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | Yes | Target agent's PTY session name |
| `message` | Yes | The message text to send |

## Example

```bash
bash config/skills/agent/send-message/execute.sh '{"to":"qa-1","message":"PR #42 is ready for review. I added unit tests for the auth module."}'
```

## Output

JSON confirmation of message delivery.

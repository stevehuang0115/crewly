---
name: Send Chat Response
description: Send a chat response visible in the Crewly chat UI.
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
  - send chat
  - reply chat
  - chat response
  - respond to user
tags:
  - chat
  - communication
  - response
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Send Chat Response

Send a chat response that appears in the Crewly chat UI. Use this to communicate results, status updates, or answers directly to the user.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | Yes | The message content to display in chat |
| `senderName` | Yes | Your agent name (displayed as the message sender) |
| `senderType` | No | Sender type (e.g., `"agent"`, `"system"`) |
| `conversationId` | No | Target conversation ID. Uses the active conversation if omitted |

## Example

```bash
bash config/skills/agent/send-chat-response/execute.sh '{"content":"Login feature implemented and all tests passing.","senderName":"dev-1"}'
```

## Output

JSON confirmation that the chat message was delivered.

---
name: Broadcast
description: Send a message to all active agent sessions.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - broadcast
  - message all
  - announce
tags:
  - communication
  - broadcast
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Broadcast

Sends a message to all active agent sessions (excluding the orchestrator itself).

## Usage

```bash
bash config/skills/orchestrator/broadcast/execute.sh '{"message":"Team standup in 5 minutes"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `message` | Yes | The message to broadcast |

## Output

JSON with count of sent/failed deliveries.

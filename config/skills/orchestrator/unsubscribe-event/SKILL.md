---
name: Unsubscribe from Event
description: Cancel an event subscription by ID.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - unsubscribe event
  - cancel subscription
tags:
  - events
  - monitoring
  - subscription
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Unsubscribe from Event

Cancel an event subscription.

## Usage

```bash
bash config/skills/orchestrator/unsubscribe-event/execute.sh '{"subscriptionId":"sub-abc123"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `subscriptionId` | Yes | The subscription ID to cancel |

## Output

JSON confirmation of cancellation.

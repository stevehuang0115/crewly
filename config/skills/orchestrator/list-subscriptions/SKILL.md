---
name: List Subscriptions
description: List your active event subscriptions.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - list subscriptions
  - show subscriptions
  - active subscriptions
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

# List Subscriptions

Lists all active event subscriptions.

## Usage

```bash
bash config/skills/orchestrator/list-subscriptions/execute.sh
```

## Parameters

None required.

## Output

JSON array of active subscriptions with their IDs, event types, and filters.

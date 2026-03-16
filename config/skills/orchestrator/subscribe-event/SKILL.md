---
name: Subscribe to Event
description: Subscribe to agent lifecycle events (idle, busy, active, inactive, status_changed).
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - subscribe event
  - watch agent
  - notify when
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

# Subscribe to Event

Subscribe to agent lifecycle events. Matched events arrive as `[EVENT:subId:eventType]` in your terminal.

## Usage

```bash
bash config/skills/orchestrator/subscribe-event/execute.sh '{"eventType":"agent:idle","filter":{"sessionName":"agent-joe"},"oneShot":true}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `eventType` | Yes | Event type: `agent:idle`, `agent:busy`, `agent:active`, `agent:inactive`, `agent:status_changed` |
| `filter` | No | Filter object, e.g. `{"sessionName":"..."}` |
| `oneShot` | No | If true, auto-unsubscribe after first match |

## Output

JSON with subscription ID for later management.

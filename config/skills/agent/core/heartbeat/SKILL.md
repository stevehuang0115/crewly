---
name: Heartbeat
description: Perform a lightweight health check to confirm the agent is responsive. Updates the heartbeat timestamp via the API middleware.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - devops
  - pm
  - tpm
triggers:
  - heartbeat
  - health check
tags:
  - monitoring
  - heartbeat
  - health
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Agent Heartbeat Skill

Perform a lightweight health check to confirm that you are responsive.

## When to Use

Run this skill when the system asks you to perform a heartbeat check. This updates your heartbeat timestamp so the monitoring system knows you are alive and responsive.

## Usage

```bash
bash config/skills/agent/heartbeat/execute.sh
```

No parameters required.

## Output

Returns a JSON object with:
- `status`: "ok" if the health endpoint responded
- `timestamp`: UTC timestamp of the check
- `session`: your session name
- `health`: response from the health endpoint

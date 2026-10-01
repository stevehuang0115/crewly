---
name: Restart Crewly
description: Restarting Crewly is owner-only. This skill tells you how to ask the owner to restart it from the dashboard.
version: 2.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - restart crewly
  - restart backend
  - restart server
  - reboot server
tags:
  - system
  - management
  - restart
  - server
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Restart Crewly

Restarting (and upgrading) Crewly is the owner's decision. `POST /api/system/restart`
refuses any call that carries an agent session (403, code `owner-only`), so an
agent cannot restart the machine it runs on.

When a restart is needed, tell the owner why and ask them to press **Restart**
in the dashboard: **Settings > System > Version & Restart**. "When idle" lets
every agent finish its current turn first; the dashboard shows progress and
reports "Restarted at ..." when Crewly is back.

## Usage

```bash
bash config/skills/orchestrator/restart-crewly/execute.sh
```

It prints the owner-only refusal and exits 1. It does not restart anything.

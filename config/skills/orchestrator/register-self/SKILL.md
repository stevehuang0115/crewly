---
name: Register Self
description: Register the orchestrator as active with the Crewly backend. Must be called on startup.
version: 1.0.0
category: system
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - register
  - check in
  - go online
tags:
  - system
  - registration
  - startup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Register Self

Registers the orchestrator as active with the Crewly backend. Call this immediately on startup.

## Usage

```bash
bash config/skills/orchestrator/register-self/execute.sh '{"role":"orchestrator","sessionName":"crewly-orc"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `role` | Yes | Your role, typically `"orchestrator"` |
| `sessionName` | Yes | Your PTY session name (use `{{SESSION_ID}}`) |
| `claudeSessionId` | No | Claude session ID for resume support |

## Output

JSON confirmation of registration status.

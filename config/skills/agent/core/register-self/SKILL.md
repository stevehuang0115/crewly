---
name: Register Self
description: Register the agent as active with the Crewly backend. Must be called on startup.
version: 1.0.0
category: system
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

Register this agent as active with the Crewly backend. This must be the first skill you run on startup.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `role` | Yes | Agent role (e.g., "developer", "qa", "tpm") |
| `sessionName` | Yes | Your session name (from your identity) |
| `teamMemberId` | No | Your team member ID |
| `claudeSessionId` | No | Claude session ID for resume support |

## Example

```bash
bash config/skills/agent/core/register-self/execute.sh '{"role":"developer","sessionName":"dev-1"}'
```

---
name: Suppress Noise
description: Mark a topic as noise so you stop giving it attention. Suppressed topics are listed in your prompt and removed from your focus list.
version: 1.0.0
category: memory
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
  - orchestrator
triggers:
  - suppress
  - ignore topic
  - stop tracking
  - that's noise
tags:
  - memory
  - attention
  - self-improvement
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Suppress Noise

Add one topic to your suppressed list. Use it when past context keeps pulling you toward something that no longer matters (a retired service, a resolved incident, a stale request). The item is removed from your focus list if it was there, and shows up in your prompt under "Ignore" (up to 5).

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--item` / `-i` | `item` | Yes | The topic to suppress |
| `--session` / `-s` | `sessionName` | No | Your session name — defaults to `$CREWLY_SESSION_NAME` |

## Examples

```bash
bash execute.sh --item "legacy webhook retries"
bash execute.sh '{"item":"legacy webhook retries"}'
```

## Output

`{ "success": true, "focus": [...], "suppressed": [...] }` — the attention state after the update.

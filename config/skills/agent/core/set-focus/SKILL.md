---
name: Set Focus
description: Replace your current focus list — the topics you should prioritise until further notice. Injected into your prompt on the next session.
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
  - set focus
  - focus on
  - prioritise
  - prioritize
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

# Set Focus

Replace your focus list with a new set of topics. Focus items are the things you should keep front of mind — an active incident, a deadline, a recurring mistake you are correcting. They show up in your prompt (up to 5) and are pruned automatically after two weeks without an update, so refresh them when they still matter.

Setting focus **replaces** the whole list. To drop a single distraction instead, use `suppress-noise`.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--item` / `-i` (repeatable) | `items` (array) | Yes | Focus items, one per flag (or a JSON array) |
| `--session` / `-s` | `sessionName` | No | Your session name — defaults to `$CREWLY_SESSION_NAME` |

## Examples

```bash
# CLI flags (preferred)
bash execute.sh --item "ship checkout v2 by Friday" --item "flaky payment e2e"

# Legacy JSON
bash execute.sh '{"items":["ship checkout v2 by Friday","flaky payment e2e"]}'
```

## Output

`{ "success": true, "focus": [...], "suppressed": [...] }` — the attention state after the update.

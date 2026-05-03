---
name: Supersede Memory
description: Mark a stale memory entry as superseded by a newer one. Hides the old entry from default recall while keeping it in the audit log.
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
triggers:
  - supersede memory
  - replace memory
  - update outdated memory
tags:
  - memory
  - supersession
  - audit
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Supersede Memory

Mark a stale memory entry as superseded by a newer one. After this call, default `recall` will hide the old entry but keep it in the raw store for audit.

Use this when a fact you previously remembered has been updated — for example, when a price, a process, or a decision changes, and the old entry would now confuse the agent if returned alongside the new one.

## Usage

```bash
# CLI flags (preferred)
bash execute.sh \
  --agent crewly-product-max-c69ce8e6 \
  --old-id rk-pricing-799 \
  --new-id rk-pricing-800-plus-credits \
  --reason "Steve updated pricing 2026-05-01"

# Legacy JSON
bash execute.sh '{
  "agentId": "crewly-product-max-c69ce8e6",
  "oldId": "rk-pricing-799",
  "newId": "rk-pricing-800-plus-credits",
  "reason": "Steve updated pricing 2026-05-01"
}'
```

## Required Parameters
- `--agent`  / `agentId`: The agent whose memory store contains both entries
- `--old-id` / `oldId`:  The id of the entry being superseded
- `--new-id` / `newId`:  The id of the new entry that replaces the old one

## Optional Parameters
- `--reason` / `reason`: Human-readable reason. Appended to the old entry's `evidence` as `supersession-reason:<reason>` so the audit trail survives.

## Behavior
1. Validates that both ids resolve to existing entries in the agent's memory.
2. Validates that `oldId !== newId` (an entry cannot supersede itself).
3. Sets `superseded=true` and `supersededBy=newId` on the old entry.
4. Extends the old entry's `evidence` with a supersession marker.
5. Persists via the canonical write path (atomic + cache-invalidating).
6. After this call, default recall hides the old entry; explicit recall with `includeHidden=true` still returns it.

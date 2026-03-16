---
name: Recall
description: Retrieve stored memories relevant to a given context or query.
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
  - recall
  - search memory
  - remember what
  - look up
tags:
  - memory
  - recall
  - search
  - context
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Recall

Retrieve stored memories relevant to a given context or query. Use this to look up past decisions, architectural patterns, or findings before starting related work.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentId` | Yes | Your agent ID |
| `context` | Yes | Search context or query describing what you want to recall |
| `scope` | No | Filter by scope: `"project"`, `"team"`, or `"global"` |
| `limit` | No | Maximum number of results to return |
| `projectPath` | No | Filter by project path |

## Example

```bash
bash config/skills/agent/recall/execute.sh '{"agentId":"dev-1","context":"authentication implementation patterns","scope":"project","limit":5}'
```

## Output

JSON array of matching memory entries with content, category, scope, and timestamps.

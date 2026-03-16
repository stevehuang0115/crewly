---
name: Remember
description: Store a memory entry for future recall. Use this to persist important context, decisions, or findings.
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
  - remember
  - save memory
  - store context
  - note this
tags:
  - memory
  - persistence
  - context
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Remember

Store a memory entry for future recall. Use this to persist important context, decisions, architectural findings, or patterns you discover during work.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentId` | Yes | Your agent ID |
| `content` | Yes | The content to remember |
| `category` | Yes | Memory category. Agent scope supports `fact`, `pattern`, `preference`. Project scope supports `pattern`, `decision`, `gotcha`, `relationship`, `user_preference` |
| `scope` | Yes | Memory scope: `"agent"` or `"project"` |
| `projectPath` | No | Associated project path |
| `metadata` | No | Additional metadata object |

## Example

```bash
bash config/skills/agent/core/remember/execute.sh '{"agentId":"dev-1","content":"User prefers PDF delivery in Slack thread after daily brief.","category":"user_preference","scope":"project","projectPath":"/projects/app"}'
```

## Output

JSON confirmation that the memory entry was stored.

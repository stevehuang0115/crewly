---
name: Record Learning
description: Record a learning or insight gained during task execution for team knowledge sharing.
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
  - record learning
  - learned that
  - new insight
  - knowledge share
tags:
  - memory
  - learning
  - knowledge
  - insight
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Record Learning

Record a learning or insight gained during task execution. These learnings are shared with the team and accumulated over time to improve future work.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentId` | Yes | Your agent ID |
| `agentRole` | Yes | Your role (e.g., `"developer"`, `"qa"`) |
| `projectPath` | Yes | Absolute path to the project |
| `learning` | Yes | Description of the learning or insight |
| `relatedTask` | No | Path or ID of the task that triggered this learning |
| `relatedFiles` | No | Array of file paths related to the learning |

## Example

```bash
bash config/skills/agent/record-learning/execute.sh '{"agentId":"dev-1","agentRole":"developer","projectPath":"/projects/app","learning":"Jest mock resets are required between tests when using shared module mocks","relatedTask":"implement-auth-tests","relatedFiles":["src/auth.service.test.ts"]}'
```

## Output

JSON confirmation that the learning was recorded.

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

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--agent` / `-a` | `agentId` | Yes | Your agent ID / session name |
| `--role` / `-r` | `agentRole` | Yes | Your role (e.g., `developer`, `qa`) |
| `--project` / `-p` | `projectPath` | Yes | Absolute path to the project |
| `--learning` / `-l` | `learning` | Yes | The learning or insight (or pipe via stdin) |
| `--learning-file` | — | No | Read learning from a file path |

## Examples — CLI Flags (preferred)

```bash
# Record a learning
bash execute.sh --agent dev-1 --role developer --project /projects/app --learning "Jest mock resets are required between tests"

# Learning via stdin (for text with special characters)
echo "Don't use git add -A — it catches .env files" | bash execute.sh --agent dev-1 --role developer --project /projects/app

# Learning from file
bash execute.sh --agent dev-1 --role developer --project /projects/app --learning-file /tmp/insight.txt
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"agentId":"dev-1","agentRole":"developer","projectPath":"/projects/app","learning":"Jest mock resets are required between tests"}'
```

## Output

JSON confirmation that the learning was recorded.

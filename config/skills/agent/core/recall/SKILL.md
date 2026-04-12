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

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--agent` / `-a` | `agentId` | Yes | Your agent ID / session name |
| `--context` / `-c` | `context` | Yes | Search query (or pipe via stdin) |
| `--scope` / `-s` | `scope` | No | Filter: `project`, `team`, or `global` |
| `--limit` / `-l` | `limit` | No | Max number of results |
| `--project` / `-p` | `projectPath` | No | Filter by project path |

## Examples — CLI Flags (preferred)

```bash
# Search project memory
bash execute.sh --agent dev-1 --context "authentication implementation patterns" --scope project --project /projects/app

# Quick recall with limit
bash execute.sh --agent dev-1 --context "deployment process" --limit 5

# Context via stdin
echo "how does the relay service work" | bash execute.sh --agent dev-1 --project /projects/app
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"agentId":"dev-1","context":"authentication patterns","scope":"project","limit":5}'
```

## Output

JSON array of matching memory entries with content, category, scope, and timestamps.

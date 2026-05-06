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

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--agent` / `-a` | `agentId` | Yes | Your agent ID / session name |
| `--content` / `-c` | `content` | Yes | Content to remember (or pipe via stdin) |
| `--content-file` | — | No | Read content from a file path |
| `--category` / `-C` | `category` | Yes | See category × scope matrix below |
| `--scope` / `-s` | `scope` | Yes | Scope: `agent` or `project` |
| `--project` / `-p` | `projectPath` | No | Project path (required for `project` scope) |

### Valid `category` × `scope` matrix

| Category          | `scope=agent` | `scope=project` | Notes |
|-------------------|:-------------:|:---------------:|-------|
| `fact`            | ✅            | —               | Personal best-practice / "always do X". |
| `pattern`         | ✅            | ✅              | Reusable workflow or code pattern. |
| `gotcha`          | ✅ (F4 fix)   | ✅              | Things to avoid; agent-scope = personal, project-scope = team-wide. |
| `preference`      | ✅            | —               | Updates your `AgentPreferences` (verbosity, breakdown size, etc.). |
| `decision`        | —             | ✅              | Architectural / design decision (project-only). |
| `relationship`    | —             | ✅              | Component-to-component edge in the codebase (project-only). |
| `user_preference` | —             | ✅              | Project-scoped user preference (project-only). |

> **Aliases / common mistakes:**
> - `workflow` is **not** a public category — use `pattern` (it maps to internal `workflow` automatically).
> - For "this approach failed for me last time" → use `category=gotcha scope=agent` (don't pollute project memory).

## Examples — CLI Flags (preferred)

```bash
# Store a project-wide pattern
bash execute.sh --agent dev-1 --content "User prefers PDF delivery in Slack thread" --category user_preference --scope project --project /projects/app

# Content via stdin (for text with special characters)
echo "Jest mock resets are required between tests — don't forget" | bash execute.sh --agent dev-1 --category gotcha --scope project --project /projects/app

# Content from file
bash execute.sh --agent dev-1 --content-file /tmp/finding.txt --category decision --scope project --project /projects/app
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"agentId":"dev-1","content":"User prefers PDF delivery","category":"user_preference","scope":"project","projectPath":"/projects/app"}'
```

## Output

JSON confirmation that the memory entry was stored.

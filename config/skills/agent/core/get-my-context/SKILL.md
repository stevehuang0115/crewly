---
name: Get My Context
description: Retrieve your accumulated context including memories, learnings, and project knowledge.
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
  - get context
  - my context
  - what do I know
  - load context
tags:
  - memory
  - context
  - knowledge
  - startup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get My Context

Retrieve your accumulated context including memories, learnings, and project knowledge. Use this at startup or when beginning a new task to load relevant background information.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentId` | Yes | Your agent ID |
| `agentRole` | Yes | Your role (e.g., `"developer"`, `"qa"`) |
| `projectPath` | Yes | Absolute path to the current project |
| `context` | No | What to recall for (`--context`). Default: `"<role> agent context for current work"`. At startup pass `"<role> session startup, recent tasks, unfinished work, blockers, key decisions"` |

This skill **includes your memory recall** (plus goals, focus, today's log, learnings
and your task timings). Do not run `recall` as well at startup — that is the same
search twice (#857).

## Example

```bash
bash config/skills/agent/get-my-context/execute.sh '{"agentId":"dev-1","agentRole":"developer","projectPath":"/projects/app"}'
```

## Output

JSON with your accumulated context including past memories, learnings, project-specific knowledge, team SOPs, and relevant history.

Once you have completed at least two tasks of a kind, `data.taskTimings` summarizes how long your own tasks took (median, fastest, slowest, n per kind) and how your ETAs compare. Base the ETAs you give on it.

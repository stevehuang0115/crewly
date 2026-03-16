---
name: Resume Session
description: "Resume a Claude Code agent's most recent conversation using /resume."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - resume session
  - resume conversation
  - resume agent
tags:
  - session
  - resume
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Resume Session

Resumes a Claude Code agent's most recent conversation using the `/resume` slash command. This preserves the full previous conversation context (tool calls, file reads, history) instead of starting a brand new session with a lossy context dump.

## How It Works

1. Sends `/resume` to the target agent's Claude Code session via the `/deliver` endpoint
2. Waits for Claude Code to render the session picker (3 seconds)
3. Sends Enter to select the most recent (first) session in the picker

## Usage

```bash
bash config/skills/orchestrator/resume-session/execute.sh '{"sessionName":"agent-joe"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | Target agent's PTY session name |

## Output

JSON confirmation from the deliver and key endpoints.

## Notes

- This skill only works with Claude Code runtimes. On other runtimes, `/resume` is treated as a normal message (harmless but no-op).
- The agent must have a previous session to resume. If no previous session exists, Claude Code will show an empty picker and Enter will dismiss it.
- Prefer this over `delegate-task` with full context when you want to restore an agent's prior conversation rather than start fresh.

---
name: Send Message
description: "Send a direct message to another agent's terminal session."
version: 1.0.0
category: communication
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
  - send message
  - message agent
  - tell agent
  - dm agent
tags:
  - communication
  - agent
  - message
  - terminal
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Message

Send a direct message to another agent's terminal session. The message is written to the target agent's PTY using the two-step message mode for reliable delivery.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--to` / `-t` | `to` | Yes | Target agent's PTY session name |
| `--message` / `-m` | `message` | Yes | Message text (or pipe via stdin) |
| `--message-file` | — | No | Read message from a file path |

## Examples — CLI Flags (preferred)

```bash
# Simple message
bash execute.sh --to qa-1 --message "PR #42 is ready for review"

# Multi-line message via stdin (avoids shell escaping)
echo "PR #42 is ready for review. It's passing all tests." | bash execute.sh --to qa-1

# Message from file
bash execute.sh --to qa-1 --message-file /tmp/task-details.txt
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"to":"qa-1","message":"PR #42 is ready for review."}'
```

## Output

JSON confirmation of message delivery.

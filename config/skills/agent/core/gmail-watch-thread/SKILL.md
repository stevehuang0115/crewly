---
name: Gmail Watch Thread
description: Get woken when someone replies in a Gmail thread. Starts (or stops) watching a thread; a reply fires the gmail:reply_received event that watch-for-event can target.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - wait for reply
  - watch email thread
  - wake on reply
tags:
  - google
  - gmail
  - email
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Gmail Watch Thread

Tells Crewly to watch one Gmail thread for **new replies** (from anyone but
the owner) and attributes the watch to you. A thread you drafted a reply in is
watched automatically once the owner approves the send; use this skill for any
other thread, e.g. one you found with `gmail-search`.

It only registers the watch. To actually be woken, pair it with
`watch-for-event`:

```bash
bash execute.sh --thread-id 18f0a1b2c3d4e5f6
bash ../watch-for-event/execute.sh --event-type gmail:reply_received \
  --filter-json '{"threadId":"18f0a1b2c3d4e5f6"}' --title "Reply on the Q3 thread"
```

Existing messages never fire; each new reply fires once, even across restarts.
Only the connected owner account is watched.

## Usage

| Flag | Meaning |
|---|---|
| `--thread-id` | Gmail thread id to watch (from `gmail-search` / `gmail-read` `threadId`) |
| `--list` | Show your watched threads |
| `--stop` | With `--thread-id`: stop watching it |
| `--account` | Which connected Google account (default: primary) |

Output: `{"success":true,"threadId":"…","event":"gmail:reply_received"}`.

---
name: To Do Tasks
description: List the tasks in one of the owner's Microsoft To Do lists — open tasks by default, --all to include completed ones (via the Microsoft grant held by Crewly Cloud). Read-only.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - what is on my to do list
  - list microsoft to do tasks
  - open tasks in to do
  - outlook tasks
tags:
  - microsoft
  - todo
  - tasks
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# To Do Tasks

```bash
bash execute.sh                        # open tasks of the default list ("Tasks")
bash execute.sh --list Groceries       # name (case-insensitive) or id
bash execute.sh --list Work --all      # include completed tasks
bash execute.sh --list Work --limit 20 # default 50, max 100
```

## Output

```json
{"list":{"id":"AAMk…","name":"Work"},"count":2,"tasks":[{"id":"AAMk…","title":"Send deck to Ann","status":"notStarted","importance":"high","due":"2026-10-01","note":"v3 is in Drive"},{"id":"AAMk…","title":"Book venue","status":"completed","completedAt":"2026-09-20"}]}
```

`importance` appears only when not normal; `note` is plain text, cut at
200 characters. `hasMore: true` means the list has more tasks than the
limit. Use the task `id` with todo-update.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Microsoft To Do (Connections → Microsoft To Do).
Other reasons: `not_found` (unknown list / task — the message lists the
available lists), `forbidden` (the account has no Exchange Online mailbox, or
the organisation blocks the app), `rate_limited` (with `retryAfter` seconds),
`validation`, `connector_forbidden` (the owner has not allowed your role).

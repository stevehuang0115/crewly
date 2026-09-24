---
name: To Do Lists
description: List the owner's Microsoft To Do task lists, or create a new list (via the Microsoft grant held by Crewly Cloud).
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
  - microsoft to do lists
  - which to do lists
  - create a to do list
  - outlook tasks lists
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

# To Do Lists

```bash
bash execute.sh
bash execute.sh --create "Trip to Lisbon"
```

## Output

```json
{"count":2,"lists":[{"id":"AAMk…","name":"Tasks","isDefault":true},{"id":"AAMk…","name":"Groceries","isShared":true}]}
{"success":true,"list":{"id":"AAMk…","name":"Trip to Lisbon"}}
```

The other todo-* skills take a list **name** (case-insensitive) or id, so
you rarely need the id. `isDefault` marks the list that answers when no
list is named.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Microsoft To Do (Connections → Microsoft To Do).
Other reasons: `not_found` (unknown list / task — the message lists the
available lists), `forbidden` (the account has no Exchange Online mailbox, or
the organisation blocks the app), `rate_limited` (with `retryAfter` seconds),
`validation`, `connector_forbidden` (the owner has not allowed your role).

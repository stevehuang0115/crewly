---
name: To Do Update
description: Complete, reopen, retitle, re-date or delete a task — and add, tick, untick or remove its steps — in one of the owner's Microsoft To Do lists (via the Microsoft grant held by Crewly Cloud).
version: 1.1.0
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
  - mark to do task done
  - complete microsoft to do task
  - change the due date in to do
  - delete a to do task
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

# To Do Update

```bash
bash execute.sh --list Groceries --task <id> --complete
bash execute.sh --list Work --task <id> --title "Send v4 deck" --due 2026-10-03
bash execute.sh --list Work --task <id> --due none     # clear the due date
bash execute.sh --list Work --task <id> --reopen
bash execute.sh --list Work --task <id> --delete       # cannot be undone
bash execute.sh --list Groceries --task <id> --add-steps "Butter,Ham"
bash execute.sh --list Groceries --task <id> --check-steps "Eggs,Milk"    # tick steps
bash execute.sh --list Groceries --task <id> --uncheck-steps Eggs         # untick
bash execute.sh --list Groceries --task <id> --remove-steps Bread         # delete a step
```

Steps are named by title (case-insensitive) or by step id from todo-tasks.
`--add-step` / `--check-step` / `--uncheck-step` / `--remove-step` take one
step each and can be repeated, for a step whose title contains a comma.
Adding steps changes the existing task; it never creates a new one. A step
name that matches nothing (or two steps) fails before anything is changed.

`--task` is the id from todo-tasks. `--list` is the list the task is in
(name or id; the default list when omitted). Changes can be combined in one
call; `--delete` ignores the others.

## Output

```json
{"success":true,"list":"Groceries","task":{"id":"AAMk…","title":"Milk","status":"completed","completedAt":"2026-09-23"}}
{"success":true,"list":"Groceries","task":{"id":"AAMk…","title":"Costco","status":"notStarted","steps":[{"id":"…","title":"Eggs","checked":true},{"id":"…","title":"Butter","checked":false}]}}
{"success":true,"deleted":true,"list":"Work","taskId":"AAMk…"}
```

Only delete when the owner asked for it; completing keeps the history.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Microsoft To Do (Connections → Microsoft To Do).
Other reasons: `not_found` (unknown list / task — the message lists the
available lists), `forbidden` (the account has no Exchange Online mailbox, or
the organisation blocks the app), `rate_limited` (with `retryAfter` seconds),
`validation`, `connector_forbidden` (the owner has not allowed your role).

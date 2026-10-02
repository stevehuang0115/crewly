---
name: To Do Add
description: Add a task to one of the owner's Microsoft To Do lists — title, optional due date, note, importance and steps (checklist items) (via the Microsoft grant held by Crewly Cloud).
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
  - add to my to do list
  - add a microsoft to do task
  - remind me in to do
  - create an outlook task
  - add a task with steps
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

# To Do Add

```bash
bash execute.sh --title "Buy milk"                     # default list ("Tasks")
bash execute.sh --list Work --title "Send deck to Ann" --due 2026-10-01 --importance high --note "v3 is in Drive"
bash execute.sh --list Groceries --title "Costco" --steps "Eggs,Milk,Bread"   # ONE task with three steps
```

When the owner asks for items as **steps of one task** (a shopping run, a
packing list), use `--steps` — do not put them in the note, and do not make
one task per item unless he asked for separate tasks.

| Flag | Meaning |
|---|---|
| `--title` | Task title (required) |
| `--list` | List name (case-insensitive) or id; default list when omitted |
| `--due` | Due date `YYYY-MM-DD` |
| `--note` | Note shown under the task |
| `--importance` | `low` \| `normal` \| `high` |
| `--steps` | Comma-separated steps (checklist items), in order |
| `--step` | One step; repeat it for more (for a step that contains a comma) |

## Output

```json
{"success":true,"list":"Work","task":{"id":"AAMk…","title":"Send deck to Ann","status":"notStarted","importance":"high","due":"2026-10-01","note":"v3 is in Drive"}}
{"success":true,"list":"Groceries","task":{"id":"AAMk…","title":"Costco","status":"notStarted","steps":[{"id":"…","title":"Eggs","checked":false},{"id":"…","title":"Milk","checked":false}]}}
```

Steps are created after the task. If one fails, the task still exists and
the answer lists it in `failedSteps` (`[{"step":"Milk","error":"…"}]`):
add it with todo-update `--add-steps` — do **not** run todo-add again, that
would make a second task.

A list that does not exist is not created — make it with todo-lists
`--create` first.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Microsoft To Do (Connections → Microsoft To Do).
Other reasons: `not_found` (unknown list / task — the message lists the
available lists), `forbidden` (the account has no Exchange Online mailbox, or
the organisation blocks the app), `rate_limited` (with `retryAfter` seconds),
`validation`, `connector_forbidden` (the owner has not allowed your role).

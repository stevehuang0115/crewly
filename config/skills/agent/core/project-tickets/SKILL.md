---
name: Project Tickets
description: A project's own backlog — list, read, create, update, claim, release and log project tickets (markdown files in <project>/.crewly/tickets/, tracked in git).
version: 1.0.0
category: task-management
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
  - orchestrator
  - team-leader
triggers:
  - backlog
  - project ticket
  - put this in the backlog
  - claim a ticket
  - what should I work on next
tags:
  - tickets
  - backlog
  - project
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 20000
---

# Project Tickets

Every project keeps its own backlog as one markdown file per ticket in
`<project>/.crewly/tickets/<ID>-<slug>.md`. The files are tracked in git, so
the owner sees and edits them on GitHub too. Always go through this skill
(not by editing the file yourself) so the ticket and its WorkItem stay in step.

Statuses: `backlog` → `ready` → `in_progress` → `done` (or `review` when the
ticket asks for owner review), plus `cancelled`. Priorities `P0` (highest) to `P3`.

`--project` takes the project id, its name, or its absolute path.

## See what there is

```bash
# All tickets of the projects your teams work on
bash execute.sh list
# One project, only what can be picked up
bash execute.sh list --project /path/to/project --status ready
# One ticket with its description, acceptance criteria and log
bash execute.sh show --project /path/to/project --id APP-12
```

## Pick up work

```bash
bash execute.sh claim --project /path/to/project --id APP-12
```

Claiming gives you a WorkItem (`workItemId` in the output). Work it like any
other WorkItem and complete it the usual way (`complete-task` /
`report-status` with that `workItemId`). Your lead reviews it; when it is
verified the ticket moves to `done` by itself. If the review sends it back you
get a retry WorkItem and the ticket stays yours.

When you are idle and nobody assigned you anything, Crewly may also claim the
highest-priority `ready` ticket of your projects for you — you then receive it
as a normal `[CREWLY-DISPATCH]`.

Only members of the teams assigned to the project can claim, and only one
agent works a ticket at a time.

```bash
# Progress note into the ticket's Log
bash execute.sh log --project P --id APP-12 --note "API done, UI next"
# Cannot finish it? Give it back (→ ready) with the reason
bash execute.sh release --project P --id APP-12 --note "blocked on the design"
```

## Add to the backlog

```bash
bash execute.sh create --project P --title "Export the report as CSV" \
  --description "Why and what" --acceptance "A header row is present" --acceptance "Opens in Excel" \
  --priority P2 --labels export
```

- A worker's new ticket always starts in `backlog`. The owner, the
  orchestrator or a team lead makes it `ready` (`update --status ready`).
- **When the owner asks you to "put this in the backlog" / "add a ticket"**
  (orchestrator / team lead): create it with `--source request:<TKT id>` when
  it came in as a harness ticket, and tell the owner the new ticket id. Do not
  start working on it unless the owner asked for that too.

## Change a ticket

```bash
bash execute.sh update --project P --id APP-12 --priority P1 --labels "export,ui" --note "owner asked"
bash execute.sh update --project P --id APP-12 --status ready          # owner / orc / lead only
bash execute.sh update --project P --id APP-12 --acceptance "new list item" --acceptance "another"
```

`--description` and `--acceptance` replace those sections; everything else a
human wrote in the file is kept.

## Assign (orchestrator / team lead)

```bash
# The worker gets a linked WorkItem and is dispatched
bash execute.sh assign --project P --id APP-12 --to worker-session
# Only record who will do it
bash execute.sh assign --project P --id APP-12 --to worker-session --no-start
```

Only the owner, the orchestrator or a lead of a team on the project may
assign, and only to members of those teams (a person's name is recorded
without a WorkItem). Team leads also have the `assign-ticket` skill.

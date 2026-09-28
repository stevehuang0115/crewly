🚀 **Project started**

**Project:** `{projectName}`
**Project Path:** `{projectPath}`
**Teams Assigned:** `{teamName}` ({teamMemberCount} members)
**Status:** ACTIVE

The project's backlog is its **project tickets**: one markdown file per ticket in
`{projectPath}/.crewly/tickets/`, tracked with the project so the owner can see and edit them too.
Read and change them only through the `project-tickets` skill.

## How work flows

1.  Tickets start in `backlog`. A ticket becomes `ready` when the owner (or you, on the owner's
    instruction, or a team lead) says it should be done.
2.  Idle members of the project's teams pick up `ready` tickets on their own, highest priority
    first. Each pickup creates one linked WorkItem; one ticket is never worked by two agents.
3.  When the member completes the WorkItem, its lead (or you, when there is no lead) verifies it
    through the normal review item. Verified → the ticket moves to `done` (or to `review` when the
    owner asked to check it personally).

## What to do now

1.  `project-tickets list --project '{projectPath}'` — see what is in the backlog, ready and in progress.
2.  `get-team-status` — make sure the assigned team is running; start members that need to work.
3.  If the owner asked for specific work and no ticket exists yet, create it
    (`project-tickets create --project '{projectPath}' --title "…" --acceptance "…"`), and make it
    `ready` only if the owner asked for the work to start.
4.  Assign a ticket to a specific member only when it needs that person
    (`project-tickets assign --project '{projectPath}' --id <ID> --to <session>`); otherwise let the
    team pick it up.

Do not move `backlog` tickets to `ready` on your own initiative — that is the owner's call.

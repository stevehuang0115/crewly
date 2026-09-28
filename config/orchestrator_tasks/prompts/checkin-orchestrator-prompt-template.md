🔄 **Project Check-in**

**Project:** {projectName}
**Project ID**: {projectId}
**Path:** {projectPath}
**Check Time:** {currentTimestamp}

The project's work lives in two places:

-   **Project tickets** — the project's own backlog, one markdown file per ticket in
    `{projectPath}/.crewly/tickets/` (tracked with the project). Read and change them only through
    the `project-tickets` skill.
-   **WorkItems** — what agents are working on right now. Every ticket in progress has exactly one
    linked WorkItem; when that WorkItem is verified the ticket moves to done by itself.

## Step 1: What is being worked on

1.  `project-tickets list --project '{projectPath}' --status in_progress` — tickets being worked, with
    their assignee and WorkItem.
2.  `get-team-status` — who is active, idle, or stuck.
3.  For a ticket whose assignee is inactive or has shown no progress for a long time, ask the
    assignee (`send-message`) what is blocking it. If the work cannot continue, the assignee or
    the team lead releases the ticket (`project-tickets release … --note "<why>"`) so someone else
    can pick it up.

## Step 2: What is waiting

1.  `project-tickets list --project '{projectPath}' --status ready` — idle members of the project's
    teams pick these up on their own (highest priority first). Only step in when a ticket needs a
    specific person: `project-tickets assign --project '{projectPath}' --id <ID> --to <session>`.
2.  `project-tickets list --project '{projectPath}' --status review` — tickets waiting for the owner.
    Mention them in your update; do not move them to done yourself.
3.  `backlog` tickets are not approved work. Move one to `ready` only when the owner asked for it.

## Step 3: Report

Summarise in two or three lines: what moved since the last check-in, what is blocked and why,
and anything waiting for the owner.

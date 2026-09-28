# Task Assignment Prompt Template (Orchestrator)

📋 **TICKET ASSIGNMENT**

**Project:** {projectName}
**Path:** {projectPath}

**Ticket:**

-   **ID:** {taskId}
-   **Title:** {taskTitle}
-   **Description:** {taskDescription}
-   **Priority:** {taskPriority}

**READ THE TICKET FIRST**
The full requirements (description, acceptance criteria, log) are in the project ticket
`{projectPath}/.crewly/tickets/{taskId}-*.md`. Read it through the `project-tickets` skill:

```bash
project-tickets show --project '{projectPath}' --id {taskId}
```

**WORKFLOW:**

1. Read the ticket (above).
2. Check who is available: `get-team-status`.
3. Pick an existing member of a team assigned to this project, based on role and availability.
4. Assign it — the member gets a linked WorkItem and is dispatched automatically:

```bash
project-tickets assign --project '{projectPath}' --id {taskId} --to <member-session-name>
```

**RULES:**

-   Use only existing team members that are already on a team of this project; do not create teams or members.
-   A ticket that is already in progress is being worked; do not assign it twice.
-   If the assignment fails, report the error to the user.

Please acknowledge and assign the ticket.

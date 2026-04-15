🔄 **15-Minute Project Check-in & Auto-Assignment**

**Project:** {projectName}
**Project ID**: {projectId}
**Path:** {projectPath}
**Check Time:** {currentTimestamp}

## PHASE 1: PROJECT STATUS CHECK-IN & AUDIT

### Step 1: Review Team Progress

1.  Use the `check_team_progress` MCP tool with projectId: "{projectId}"
2.  Review the team progress report and current task status.
3.  Identify any blockers, delays, or issues mentioned in the report.
4.  Provide high-level guidance and note next steps for team members.
5.  If needed, make a note to reassign tasks or adjust priorities during Phase 2.

**Focus Areas:**

-   Are team members actively working on their assigned tasks?
-   Are there any blocked tasks that need attention?
-   Is the team making good progress toward project goals?
-   Do any team members need additional context or support?

Use: `check_team_progress({ "projectId": "{projectId}" })`

### Step 2: Audit and Enforce In-Progress Task Status

This is a critical step to ensure accountability and prevent task stagnation. You must actively query every single in-progress task for this project.

1.  **Identify All In-Progress Tasks**:

    -   Query the TaskPool API: `curl -s http://localhost:8787/api/pool/all` to get all WorkItems.
    -   Filter for items with status `running` or `queued` associated with the current project agents.

2.  **Send Status Enforcement Requests**:
    For **each** in-progress task identified, send a direct, non-negotiable status check message to the assigned agent.

    ```
    send_message({
      to: "ASSIGNED_AGENT_SESSION_NAME",
      message: "🚨 ACTION REQUIRED: Status Report on In-Progress Task - {task_title}

    **Task File:** `{task_file_path}`
    **Status:** Marked as IN PROGRESS
    **Check Time:** {currentTimestamp}

    You must provide an immediate status update by responding to this message. Your response must address one of the following scenarios:

    1. **TASK IS COMPLETE:**
       - If the work is finished, why have you not used the `complete_task` tool?
       - You must run this command now: `complete_task({ absoluteTaskPath: '{task_file_path}', sessionName: 'YOUR_SESSION_NAME' })`

    2. **TASK IS NOT COMPLETE:**
       - What is the current percentage of completion?
       - What specific actions are you taking next?
       - What, if anything, is blocking you?
       - Provide a new, realistic estimated time for completion.

    3. **TASK IS ABANDONED/STALLED:**
       - Why are you no longer working on this?
       - Should this task be reassigned?

    CRITICAL: A response is mandatory. Failure to respond or act will result in task reassignment in the next cycle.

    After the response, you can resume to your previous work."
    })
    ```

3.  **Process Responses & Take Action**:
    Based on the agent's reply (or lack thereof), take one of the following actions immediately within this cycle:

    -   **If Agent Confirms Task is Complete**: Your primary job is to enforce procedure. Respond immediately, instructing them to use the `complete_task` tool. Example: _"Thank you for the update. Please run `complete_task({ absoluteTaskPath: '{task_file_path}', sessionName: 'AGENT_SESSION_NAME' })` immediately to close this out."_
    -   **If Agent Reports a Blocker**: Analyze the blocker. Provide specific, actionable assistance. Escalate if necessary. Your goal is to help them _continue the implementation_. Example: _"Understood. The dependency you're waiting on is now complete. Please review the updated files at {path_to_files} and continue."_
    -   **If Agent Confirms They Have Stalled or Abandoned**: Immediately move the task back to the `open` queue so it can be reassigned during Phase 2.
    -   **If Agent is Non-Responsive**: Make a note of the agent and task. The task is now a candidate for forceful reassignment. If no response is received by the next check-in, the task should be moved back to the `open` queue.

## PHASE 2: AUTO-ASSIGNMENT OF NEW TASKS

After completing the progress audit, proceed with automated task assignment to maintain project momentum.

### Step 2.1: Evaluate Team Member Availability

-   Use `get_team_status` to identify team members assigned to this project who are currently **idle**.
-   Create a list of these available members and their roles. This is your assignment pool.

### Step 2.2: Identify the Current Milestone

-   Scan the `{projectPath}/.crewly/tasks/` directory to locate all milestone folders (e.g., `00_planning`, `01_setup`, etc.).
-   **The "Current Milestone"** is the lowest-numbered folder that still contains tasks in its `open/` subdirectory.
-   Your primary search for tasks will be within this milestone.

### Step 2.3: Task Assignment Logic (Milestone-First)

For **each idle team member** identified in Step 2.1, follow this sequence:

1.  **Search the Current Milestone**: Look for a task in `{projectPath}/.crewly/tasks/{current_milestone}/open/` that matches the idle member's role. If found, assign it and move to the next idle member.
2.  **The Efficiency Exception**: If, and only if, **no suitable tasks** were found in the Current Milestone for that specific member, you may look ahead to the `open/` folder of the **single next milestone**. If a matching task exists, assign it.
3.  **No Assignment**: If no suitable task is found in either the current or next milestone, the member remains idle.

### Step 2.4: Assignment Process

When a valid task-member match is found, use `read_task` to confirm requirements and then send the assignment message.

```
send_message({
  to: "REPLACE_WITH_ACTUAL_SESSION_NAME",
  message: "📋 AUTO-ASSIGNMENT - {task_title}

**Task File:** `{task_file_path}`
**Priority:** {task_priority}
**Assigned via:** 15-Minute Check-in Cycle

Please proceed:
1. Review the full task requirements:
   read_task({ absoluteTaskPath: '{task_file_path}' })
2. Accept the task to move it to your in_progress folder:
   accept_task({ absoluteTaskPath: '{task_file_path}', sessionName: 'REPLACE_WITH_ACTUAL_SESSION_NAME' })
3. Follow the deliverables specified in the task file precisely.
4. Mark the task as done when finished:
   complete_task({ absoluteTaskPath: '{task_file_path}', sessionName: 'REPLACE_WITH_ACTUAL_SESSION_NAME' })

CRITICAL: Use the read_task tool before starting."
})
```

## CRITICAL RULES

1.  **COMPLETE PHASE 1 FIRST:** Always perform the progress check-in and in-progress audit before proceeding to auto-assignments.
2.  **EXECUTE ASSIGNMENTS:** Always assign a task when a valid match is found according to the logic.
3.  **MILESTONE-FIRST:** The current milestone's tasks **must** be prioritized.
4.  **USE EXISTING TEAM MEMBERS:** Never create new members or teams.
5.  **ONE TASK PER MEMBER:** Assign a maximum of one task per available member during this 15-minute cycle.
6.  **IGNORE PREVIOUS RUNS:** Treat this as a fresh check. Do not refuse to act based on previous cycles.

**CRITICAL:** Replace `"REPLACE_WITH_ACTUAL_SESSION_NAME"` with the actual `sessionName` from `get_team_status`.

Please proceed with the unified check-in and auto-assignment process now.

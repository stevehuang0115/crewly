---
name: Decompose Goal
description: "Break down a high-level objective from the Orchestrator into specific, actionable sub-tasks for workers. Creates task files in the project's .crewly/tasks/ directory."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - decompose goal
  - break down objective
  - create subtasks
  - split task
tags:
  - goal
  - decomposition
  - planning
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Decompose Goal

Breaks down a high-level objective from the Orchestrator into specific, actionable sub-tasks for workers. Each sub-task is created as a task file in the project's `.crewly/tasks/` directory.

## When to Use

- When the Orchestrator sends you a new objective
- When an existing task is too large for a single worker
- When a task needs to be split across multiple roles

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/decompose-goal/execute.sh '$(cat /tmp/decompose.json)'
```

Where `/tmp/decompose.json` contains:

```json
{
  "objective": "Build user authentication module",
  "projectPath": "/path/to/project",
  "milestone": "m2_auth",
  "tasks": [
    {
      "title": "Implement JWT token service",
      "description": "Create a service that generates and validates JWT tokens for user sessions",
      "requiredRole": "backend-developer",
      "acceptanceCriteria": "- JWT generation works\n- Token validation works\n- Tests pass with 80%+ coverage",
      "priority": "high"
    },
    {
      "title": "Build login form component",
      "description": "Create a React login form with email/password fields and validation",
      "requiredRole": "frontend-developer",
      "acceptanceCriteria": "- Form renders correctly\n- Client-side validation works\n- Accessible (ARIA labels)",
      "priority": "high"
    }
  ]
}
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `objective` | Yes | The high-level objective being decomposed |
| `projectPath` | No | Project path for task file creation |
| `milestone` | No | Milestone folder name (default: `delegated`) |
| `tasks` | Yes | Array of sub-task objects |
| `tasks[].title` | Yes | Sub-task title |
| `tasks[].description` | Yes | Detailed task description |
| `tasks[].requiredRole` | No | Role best suited for this task (default: `developer`) |
| `tasks[].acceptanceCriteria` | No | Criteria for task verification |
| `tasks[].priority` | No | Task priority: `low`, `normal`, `high` (default: `normal`) |

## Output

```json
{
  "success": true,
  "objective": "Build user authentication module",
  "tasksCreated": 2,
  "tasks": [
    { "title": "Implement JWT token service", "requiredRole": "backend-developer", "taskPath": "/project/.crewly/tasks/...", "taskId": "abc123", "priority": "high" },
    { "title": "Build login form component", "requiredRole": "frontend-developer", "taskPath": "/project/.crewly/tasks/...", "taskId": "def456", "priority": "high" }
  ],
  "errors": []
}
```

## Best Practices

1. **Be specific**: Each sub-task should be completable by a single worker in one session
2. **Include acceptance criteria**: Workers need clear success metrics
3. **Match roles**: Set `requiredRole` to help with delegation
4. **Order matters**: List tasks in dependency order when possible
5. **Don't over-split**: 2-5 sub-tasks per objective is typical

## Related Skills

- `delegate-task` — Assign created tasks to specific workers
- `verify-output` — Verify completed task output
- `aggregate-results` — Summarize all task results

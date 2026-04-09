---
name: Break Down Request
description: "Decompose a V3 Request into specific, actionable WorkItems based on semantic understanding of the task."
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - architect
  - product-manager
  - developer
  - backend-developer
  - frontend-developer
  - fullstack-dev
triggers:
  - break down request
  - decompose request
  - split request into tasks
tags:
  - v3
  - request
  - decomposition
  - work-items
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Break Down Request

Decompose a V3 Request (L2 or L3) into specific, actionable WorkItems in the TaskPool. Use your LLM understanding to create meaningful task breakdowns -- do NOT use generic templates.

## WHEN to use this skill

Call this skill **after** creating an L2+ Request via the `create-request` skill. The orchestrator should:

1. Analyze the user's actual request
2. Determine the specific steps needed
3. Call this skill with a tailored list of tasks

**DO NOT** use generic decomposition. Every breakdown should be specific to what the user asked for.

## How to decompose

Think about the request like a senior engineer would:
- What are the concrete steps to accomplish this?
- What order should they happen in?
- Who is best suited for each step?
- Are there any review or validation steps needed?

## Task Types

| Type | When to use |
|------|-------------|
| delegate | Work that should be assigned to an agent for execution |
| check | Validation or verification step (tests pass, build succeeds) |
| notify | Inform someone of a status change or result |
| review | Code review, design review, or approval step |

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--request-id` | Yes | The Request ID to decompose (from create-request output) |
| `--tasks` | Yes | JSON array of task objects (use --file for complex JSON) |

### Task Object Structure

Each task in the `--tasks` array should have:

```json
{
  "title": "Create team V3-QA-Team",
  "description": "Create a new QA team named V3-QA-Team with testing focus",
  "type": "delegate",
  "priority": "normal",
  "target": "orchestrator"
}
```

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| title | Yes | string | Concise task title |
| description | Yes | string | Detailed instructions |
| type | Yes | delegate, check, notify, review | Task execution type |
| priority | No | low, normal, high, urgent | Default: normal |
| target | No | string | Target agent/role (e.g., "backend-developer", "qa-engineer") |

## Examples

### Example 1: "Create a QA team with 3 members and a project"

```bash
bash execute.sh --request-id "req_abc123" --tasks '[
  {"title": "Create team V3-QA-Team", "description": "Create a new team named V3-QA-Team focused on quality assurance", "type": "delegate", "priority": "high", "target": "orchestrator"},
  {"title": "Add member TestLead-Quinn", "description": "Add a test lead named Quinn to V3-QA-Team with role qa-engineer", "type": "delegate", "target": "orchestrator"},
  {"title": "Add member FE-Tester-Aria", "description": "Add a frontend tester named Aria to V3-QA-Team with role qa-engineer", "type": "delegate", "target": "orchestrator"},
  {"title": "Add member BE-Tester-Kai", "description": "Add a backend tester named Kai to V3-QA-Team with role qa-engineer", "type": "delegate", "target": "orchestrator"},
  {"title": "Create QA project", "description": "Create a project for V3-QA-Team to track their testing work", "type": "delegate", "target": "orchestrator"},
  {"title": "Verify team setup", "description": "Check that all 3 members are added and the project is linked", "type": "check", "target": "orchestrator"}
]'
```

### Example 2: "Build OAuth2 authentication" (using --file for complex JSON)

```bash
cat > /tmp/crewly_input.json << 'CREWLY_EOF'
{"requestId": "req_def456", "tasks": [
  {"title": "Design OAuth2 flow", "description": "Design the OAuth2 authorization code flow with Google and GitHub providers", "type": "delegate", "priority": "high", "target": "architect"},
  {"title": "Implement OAuth2 routes", "description": "Create Express routes for /auth/google, /auth/github, /auth/callback", "type": "delegate", "priority": "high", "target": "backend-developer"},
  {"title": "Implement token management", "description": "Build JWT token generation, refresh, and validation logic", "type": "delegate", "priority": "high", "target": "backend-developer"},
  {"title": "Write auth tests", "description": "Write unit and integration tests for OAuth2 flow with mocked providers", "type": "delegate", "target": "qa-engineer"},
  {"title": "Review auth implementation", "description": "Security review of the OAuth2 implementation", "type": "review", "target": "architect"}
]}
CREWLY_EOF
bash execute.sh --file /tmp/crewly_input.json
```

## Output

JSON summary of created WorkItems:
- `workItemIds` -- Array of created WorkItem IDs
- `requestId` -- The parent Request ID
- `count` -- Number of WorkItems created

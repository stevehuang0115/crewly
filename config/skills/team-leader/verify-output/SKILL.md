---
name: Verify Output
description: "Execute the team's verification pipeline against a completed task. Reads verificationPipeline configuration from the team template and runs each verification step sequentially."
version: 1.0.0
category: quality
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - verify output
  - check work
  - review task
  - quality check
  - verify task
tags:
  - verification
  - quality
  - review
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Verify Output

Executes the team's verification pipeline against a completed task. Reads the task output and runs verification checks (build, tests, content scans) based on the team template configuration.

Supports two modes:
1. **Explicit checks**: Pass `checks[]` array directly with specific verification steps
2. **Template pipeline**: Pass `templateId` to automatically load verification steps from the team template's `verificationPipeline`

## When to Use

- When a worker reports a task as `done`
- When `report-status` indicates task completion
- Before marking a task as verified and reporting to the Orchestrator

## Usage

### With explicit checks (legacy)
```bash
bash {{SKILLS_PATH}}/team-leader/verify-output/execute.sh '{"taskId":"task-123","taskPath":"/project/.crewly/tasks/m1/done/task.md","workerId":"worker-1","teamId":"team-123","projectPath":"/path/to/project","checks":[{"name":"build","command":"npm run build"},{"name":"tests","command":"npm test"}]}'
```

### With template pipeline (recommended)
```bash
bash {{SKILLS_PATH}}/team-leader/verify-output/execute.sh '{"taskId":"task-123","taskPath":"/project/.crewly/tasks/m1/done/task.md","workerId":"worker-1","teamId":"team-123","projectPath":"/path/to/project","templateId":"dev-fullstack"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskId` | No* | Task ID for tracking lookup |
| `taskPath` | No* | Absolute path to the task markdown file |
| `workerId` | No | ID of the worker who completed the task |
| `teamId` | No | Team ID (for context) |
| `projectPath` | No | Project directory (required for command-type checks) |
| `templateId` | No | Template ID to load verification pipeline from |
| `checks` | No | Array of verification steps (overrides template pipeline) |

*At least one of `taskId` or `taskPath` is required.

## Check Types

### Command checks (default)
Run a shell command in the project directory and check exit code:
```json
{ "name": "build", "type": "command", "command": "npm run build" }
```

### Content scan checks
Search task output for a regex pattern:
```json
{ "name": "has-tests", "type": "content-scan", "pattern": "test.*pass|coverage.*[89]\\d%" }
```

### Manual review steps
Steps that require Team Leader judgment (auto-loaded from template pipeline):
```json
{ "name": "code-review", "type": "manual", "method": "code_review", "description": "Review code diff" }
```

## Template Pipeline Integration

When `templateId` is provided and `checks` is empty, the skill loads the verification pipeline from the template API (`GET /api/templates/:id`) and converts pipeline steps to checks:

| Pipeline Method | Execution |
|----------------|-----------|
| `quality_gates` | Runs gate commands (typecheck, tests, build, lint) |
| `e2e_test` | Runs end-to-end test framework |
| `code_review` | Marked as manual review for TL |
| `screenshot_review` | Marked as manual review for TL |
| `gemini_vision` | Marked as manual review for TL |
| `content_check` | Marked as manual review for TL |
| `fact_check` | Marked as manual review for TL |
| `source_verify` | Marked as manual review for TL |
| `data_validate` | Marked as manual review for TL |
| `browser_test` | Marked as manual review for TL |
| `manual_review` | Marked as manual review for TL |
| `custom_script` | Marked as manual review for TL |

### Pass Policies

The template's `passPolicy` controls the overall pass/fail determination:

| Policy | Behavior |
|--------|----------|
| `all` | All checks must pass (default) |
| `majority` | More than 50% of checks must pass |
| `critical_only` | Only critical steps must pass |

## Output

```json
{
  "passed": false,
  "score": 67,
  "feedback": "Verification failed: 1/3 checks failed (policy: critical_only).",
  "passPolicy": "critical_only",
  "failedSteps": ["quality-gates-tests"],
  "results": [
    { "name": "quality-gates-build", "passed": true, "critical": true, "output": "..." },
    { "name": "quality-gates-tests", "passed": false, "critical": true, "output": "3 tests failed..." },
    { "name": "code-review", "passed": true, "critical": true, "output": "Requires TL judgment: Code Review", "method": "code_review", "requiresReview": true }
  ],
  "taskId": "task-123",
  "workerId": "worker-1",
  "templateId": "dev-fullstack"
}
```

## Decision Flow After Verification

```
passed: true  → Report success to Orchestrator via aggregate-results
passed: false → Call handle-failure with the failure details
requiresReview: true → TL must manually evaluate these steps
```

## Related Skills

- `handle-failure` — Handle verification failures
- `aggregate-results` — Include verification results in reports
- `decompose-goal` — Original task decomposition

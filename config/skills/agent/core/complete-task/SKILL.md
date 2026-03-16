---
name: Complete Task
description: Mark a task as complete with a summary of the work done.
version: 1.1.0
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
triggers:
  - complete task
  - finish task
  - mark done
  - task done
tags:
  - task
  - completion
  - status
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Complete Task

Mark a task as complete with a summary of the work done. If the task has an output schema, provide structured output that will be validated against the schema. Optionally skip quality gates if they have already been verified separately.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `absoluteTaskPath` | Yes | Absolute filesystem path to the task file |
| `sessionName` | Yes | Your agent session name |
| `summary` | Yes | Summary of the work completed |
| `output` | No | Structured output object (required if task has an output schema) |
| `skipGates` | No | Set to `true` to skip quality gate checks |

## Example

```bash
bash config/skills/agent/complete-task/execute.sh '{"absoluteTaskPath":"/projects/app/tasks/implement-login.md","sessionName":"dev-1","summary":"Implemented login form with validation and tests"}'
```

### With structured output

```bash
bash config/skills/agent/complete-task/execute.sh '{"absoluteTaskPath":"/projects/app/tasks/implement-login.md","sessionName":"dev-1","summary":"Implemented login","output":{"summary":"Login form with validation","filesChanged":["src/login.tsx","src/login.test.tsx"],"testsAdded":2}}'
```

## Output Schema

If the task markdown contains an `## Output Schema` section with a JSON Schema definition, your `output` object must validate against that schema. If validation fails, the response will include the errors and you can retry (up to 2 retries). After max retries, the task will be moved to blocked/.

## Pre-Completion Checklist

Before calling this skill, verify:

1. **All requirements met** — re-read the original task and confirm every requirement is addressed
2. **Code tested** — if you wrote code, run the relevant tests and confirm they pass
3. **URLs verified** — if your output includes URLs or links, verify they are valid
4. **Sources cited** — for research tasks, ensure all factual claims have source references
5. **Summary accurate** — your summary should reflect what was actually done, not just what was planned

## Output

JSON confirmation of task completion status. If validation fails:
```json
{
  "success": false,
  "validationFailed": true,
  "errors": ["error details"],
  "retryCount": 1,
  "maxRetries": 2,
  "message": "Output validation failed. 1 retries remaining."
}
```

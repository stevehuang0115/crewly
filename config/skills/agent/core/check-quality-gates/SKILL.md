---
name: Check Quality Gates
description: Run quality gate checks (build, tests, lint) against the project before completing a task.
version: 1.0.0
category: quality
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
  - check quality
  - run gates
  - quality gates
  - verify build
  - run tests
tags:
  - quality
  - testing
  - build
  - lint
  - gates
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 300000
---

# Check Quality Gates

Run quality gate checks against the project. This includes build verification, linting, unit tests, and any other configured gates. Use this before completing a task to ensure your changes meet project standards.

Note: This operation may take several minutes depending on the project size and configured gates.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Absolute path to the project directory |
| `gates` | No | Array of specific gates to run (e.g., `["build", "test", "lint"]`). Runs all if omitted |
| `skipOptional` | No | Set to `true` to skip optional quality gates |

## Example

```bash
bash config/skills/agent/check-quality-gates/execute.sh '{"projectPath":"/projects/app","gates":["build","test"]}'
```

## Output

JSON with results for each quality gate including pass/fail status, duration, and any error details.

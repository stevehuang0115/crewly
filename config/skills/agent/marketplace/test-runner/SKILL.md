---
name: Test Runner
description: Detect the test framework and run tests with coverage reporting.
version: 1.0.0
category: testing
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - qa-engineer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - generalist
triggers:
  - run tests
  - test
  - test runner
  - execute tests
  - check tests
tags:
  - testing
  - jest
  - vitest
  - pytest
  - coverage
  - ci
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Test Runner

Detect the project's test framework (Jest, Vitest, pytest, Mocha) and run tests with optional coverage reporting. Returns a summary of test results.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the project (defaults to `.`) |
| `pattern` | No | Test path pattern to filter which tests to run |
| `coverage` | No | Set to `true` to generate coverage report |
| `framework` | No | Force a specific framework: `jest`, `vitest`, `pytest`, `mocha` |

## Auto-Detection Order

1. `vitest.config.ts/js` -> Vitest
2. `jest.config.js/ts` or `package.json#jest` -> Jest
3. `pytest.ini` / `pyproject.toml` / `setup.cfg` -> pytest
4. `package.json#scripts.test` content -> match framework name
5. Falls back to `npm test`

## Examples

### Run all tests with auto-detection

```bash
bash config/skills/agent/test-runner/execute.sh '{"projectPath":"."}'
```

### Run specific tests with coverage

```bash
bash config/skills/agent/test-runner/execute.sh '{"projectPath":".","pattern":"src/services/","coverage":true}'
```

### Force Jest framework

```bash
bash config/skills/agent/test-runner/execute.sh '{"framework":"jest","pattern":"auth"}'
```

## Output

```json
{
  "framework": "jest",
  "command": "npx jest --forceExit",
  "exitCode": 0,
  "passed": true,
  "summary": "Tests: 42 passed, 42 total..."
}
```

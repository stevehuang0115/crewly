---
name: Code Review
description: Analyze git changes and produce a structured code review with checks for style, complexity, security, and test coverage.
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - qa-engineer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - architect
triggers:
  - code review
  - review code
  - review changes
  - review PR
  - review diff
tags:
  - code-review
  - git
  - diff
  - quality
  - security
  - development
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Code Review

Analyze git changes and produce a structured code review with automated checks for missing tests, debug statements, potential secrets, large changes, and dependency modifications.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the git project (defaults to `.`) |
| `target` | No | What to review: `staged`, `unstaged`, `last-commit`, `branch` (default: `staged`) |
| `branch` | No | Compare branch when target=branch (default: `main`) |

## Example

### Review staged changes

```bash
bash config/skills/agent/code-review/execute.sh '{"projectPath":"/path/to/project","target":"staged"}'
```

### Review last commit

```bash
bash config/skills/agent/code-review/execute.sh '{"projectPath":".","target":"last-commit"}'
```

### Review changes against a branch

```bash
bash config/skills/agent/code-review/execute.sh '{"projectPath":".","target":"branch","branch":"main"}'
```

## What It Checks

1. **Missing test files** — source files (.ts/.tsx) without a corresponding .test.ts/.test.tsx
2. **Debug statements** — `console.log`, `console.debug`, `debugger` in added lines
3. **Potential secrets** — API keys, passwords, tokens, secret patterns in added code
4. **Large changes** — files with >300 lines added (may need splitting)
5. **Dependency changes** — package.json modifications that need review

## Output

JSON object with:
- `target` — what was reviewed
- `filesReviewed` — number of files in the diff
- `stats` — insertions and deletions count
- `issues` — array of detected issues with type, file, severity, and message
- `summary` — human-readable summary of findings
- `passesReview` — boolean, false if any critical or error-level issues found

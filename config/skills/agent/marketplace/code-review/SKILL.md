---
name: code-review
description: "Analyze git changes and produce a structured code review with automated checks for missing tests, debug statements, potential secrets, large changes, and dependency modifications. Use when reviewing staged changes, unstaged diffs, recent commits, or branch comparisons before submitting a pull request. For task-level quality gates, use check-quality-gates instead."
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

Analyze git changes and produce a structured code review with automated checks. The skill inspects diffs for common issues and returns a JSON report with findings, severity levels, and a pass/fail verdict.

## When to Use

Run this skill before committing or submitting a pull request to catch common issues early. It supports reviewing staged changes, unstaged modifications, the last commit, or a full branch comparison against a target branch.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the git project (defaults to `.`) |
| `target` | No | What to review: `staged`, `unstaged`, `last-commit`, `branch` (default: `staged`) |
| `branch` | No | Compare branch when `target=branch` (default: `main`) |

## Examples

### Review staged changes before committing

```bash
bash config/skills/agent/marketplace/code-review/execute.sh '{"projectPath":"/path/to/project","target":"staged"}'
```

### Review the last commit

```bash
bash config/skills/agent/marketplace/code-review/execute.sh '{"projectPath":".","target":"last-commit"}'
```

### Compare a feature branch against main

```bash
bash config/skills/agent/marketplace/code-review/execute.sh '{"projectPath":".","target":"branch","branch":"main"}'
```

### Review unstaged working directory changes

```bash
bash config/skills/agent/marketplace/code-review/execute.sh '{"projectPath":".","target":"unstaged"}'
```

## Automated Checks

The skill runs five automated checks against the diff:

1. **Missing test files** — flags `.ts`/`.tsx` source files without a corresponding `.test.ts`/`.test.tsx` in the same directory (severity: warning)
2. **Debug statements** — detects `console.log`, `console.debug`, and `debugger` in added lines (severity: error)
3. **Potential secrets** — matches patterns like `api_key=`, `password:`, `secret_key=`, and `token=` in added code (severity: critical)
4. **Large changes** — flags files with more than 300 lines added, suggesting they may need splitting (severity: warning)
5. **Dependency changes** — notes when `package.json` is modified so new dependencies can be inspected (severity: info)

## Output

```json
{
  "target": "staged",
  "filesReviewed": 5,
  "stats": { "insertions": 120, "deletions": 30 },
  "issues": [
    {
      "type": "missing-test",
      "file": "src/services/auth.ts",
      "severity": "warning",
      "message": "No corresponding test file found"
    }
  ],
  "summary": "5 files reviewed. 1 warning(s).",
  "passesReview": true
}
```

- `passesReview` is `false` when any `critical` or `error` severity issues are detected
- `issues` is an empty array when no problems are found

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Not a git repository: <path>` | `projectPath` has no `.git` directory | Provide a valid git project path |
| `Invalid target: <value>` | `target` is not one of the four accepted values | Use `staged`, `unstaged`, `last-commit`, or `branch` |
| No changes found | Diff is empty for the selected target | Stage files first for `staged`, or verify changes exist |

## Related Skills

- `git-commit-helper` — generate conventional commit messages from staged changes
- `test-runner` — run the project's test suite after reviewing changes
- `check-quality-gates` — evaluate task deliverables against project quality gates

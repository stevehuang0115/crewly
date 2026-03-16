---
name: Git Commit Helper
description: Analyze staged changes and create a well-formatted conventional commit message.
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - developer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - generalist
triggers:
  - commit
  - git commit
  - conventional commit
  - commit changes
tags:
  - git
  - commit
  - conventional-commits
  - version-control
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Git Commit Helper

Analyze staged changes and create a well-formatted conventional commit message. Supports dry-run mode to preview the commit without executing it.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `message` | No | Commit message (auto-generated if omitted) |
| `scope` | No | Scope to add, e.g. "auth" -> `feat(auth): ...` |
| `body` | No | Extended commit body text |
| `dryRun` | No | Set to `true` to preview without committing |

## Conventional Commit Types

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `style:` — Code style (formatting, semicolons)
- `refactor:` — Code change that neither fixes nor adds
- `test:` — Adding or updating tests
- `chore:` — Build, tooling, or maintenance

## Examples

### Preview a commit (dry run)

```bash
bash config/skills/agent/git-commit-helper/execute.sh '{"message":"feat: add user login","dryRun":true}'
```

### Commit with scope

```bash
bash config/skills/agent/git-commit-helper/execute.sh '{"message":"fix: resolve null pointer","scope":"api"}'
```

### Auto-generate message from staged changes

```bash
bash config/skills/agent/git-commit-helper/execute.sh '{"dryRun":true}'
```

## Output

JSON with commit result:
```json
{"success": true, "message": "feat(auth): add login", "commitHash": "abc1234"}
```

Dry run output:
```json
{"dryRun": true, "message": "feat: add login", "stagedChanges": "...stat output..."}
```

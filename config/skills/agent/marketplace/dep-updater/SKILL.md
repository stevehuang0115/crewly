---
name: Dependency Updater
description: Check for outdated npm packages and show available updates with change type.
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
  - check updates
  - outdated
  - update deps
  - dependency check
  - npm outdated
tags:
  - dependencies
  - npm
  - outdated
  - updates
  - maintenance
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Dependency Updater

Check for outdated npm packages and show available updates classified by change type (major, minor, patch). Optionally apply safe updates.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the project (defaults to `.`) |
| `type` | No | Filter: `all`, `dev`, `prod`, `major`, `minor`, `patch` |
| `update` | No | Set to `true` to run `npm update` (applies minor + patch) |

## Examples

### Check all outdated packages

```bash
bash config/skills/agent/dep-updater/execute.sh '{"projectPath":"."}'
```

### Check only major updates

```bash
bash config/skills/agent/dep-updater/execute.sh '{"type":"major"}'
```

### Apply safe updates

```bash
bash config/skills/agent/dep-updater/execute.sh '{"update":true}'
```

## Output

```json
{
  "outdatedCount": 5,
  "major": 1,
  "minor": 2,
  "patch": 2,
  "packages": [
    {
      "name": "express",
      "current": "4.18.2",
      "wanted": "4.21.0",
      "latest": "5.0.0",
      "type": "dependencies",
      "changeType": "major"
    }
  ]
}
```

---
name: Daily Standup Report
description: Generate a daily standup report from git commits, task status, and agent activity.
version: 1.0.0
category: project-management
skillType: claude-skill
assignableRoles:
  - product-manager
  - tpm
  - developer
  - generalist
  - fullstack-dev
triggers:
  - standup
  - daily standup
  - standup report
  - what did we do yesterday
tags:
  - standup
  - report
  - daily
  - git
  - status
  - project-management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Daily Standup Report

Generate a daily standup report from git commits, task status, and agent activity. Answers the three standup questions: what was done, what's planned, and any blockers.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the git project (defaults to `.`) |
| `days` | No | Number of days to look back (default: 1) |
| `author` | No | Filter git commits by author name or email |
| `includeTaskStatus` | No | Include task board status from Crewly API (default: true) |

## Example

```bash
bash config/skills/agent/daily-standup-report/execute.sh '{"projectPath":"/path/to/project","days":1}'
```

### Look back 3 days

```bash
bash config/skills/agent/daily-standup-report/execute.sh '{"projectPath":".","days":3}'
```

### Filter by author

```bash
bash config/skills/agent/daily-standup-report/execute.sh '{"projectPath":".","days":1,"author":"steve"}'
```

## Output

JSON object with:
- `date` — today's date
- `period` — time range covered
- `done` — array of commit messages from the period
- `planned` — array of active/in-progress tasks
- `blockers` — array of blocked tasks
- `stats` — git statistics (commits, files changed, insertions, deletions)
- `report` — pre-formatted markdown standup report

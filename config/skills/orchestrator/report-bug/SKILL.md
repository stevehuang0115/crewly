---
name: Report Bug
description: Submit a bug report via GitHub Issues (gh CLI) or save locally as markdown.
version: 1.0.0
category: system
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - report bug
  - submit issue
  - bug report
tags:
  - bug
  - report
  - issue
  - github
  - self-evolution
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Report Bug

Submit a bug report either as a GitHub Issue (if `gh` CLI is installed and authenticated) or as a local markdown file in `~/.crewly/bug-reports/`.

## Parameters

| Parameter | Type   | Default                     | Description                          |
|-----------|--------|-----------------------------|--------------------------------------|
| `title`   | string | (required)                  | Bug report title                     |
| `body`    | string | (required)                  | Full bug report body (markdown)      |
| `labels`  | string | `self-evolution,auto-triage`| Comma-separated GitHub issue labels  |
| `repo`    | string | (current repo)              | GitHub repo in `owner/repo` format   |

## Usage

```bash
# Submit a bug report
bash config/skills/orchestrator/report-bug/execute.sh '{"title":"Agent crashes on startup","body":"## Description\nAgent dev1 crashes...\n\n## Steps to Reproduce\n1. Start agent\n2. Observe crash\n\n## Evidence\n[log excerpts]","labels":"self-evolution,auto-triage"}'
```

## Behavior

1. **If `gh` CLI is available and authenticated:** Creates a GitHub Issue with the given title, body, and labels
2. **If `gh` is not available:** Saves the report as a markdown file at `~/.crewly/bug-reports/YYYYMMDD-HHMMSS-title.md`

## When to Use

- After completing self-evolution triage and identifying a real bug
- Only submit after getting user approval (ask before running this skill)
- Include evidence: log excerpts, timestamps, session names, error messages

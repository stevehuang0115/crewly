---
name: Bug Triage
description: Triage a bug report by searching the codebase for related files and suggesting severity, priority, and assignee.
version: 1.0.0
category: project-management
skillType: claude-skill
assignableRoles:
  - qa
  - qa-engineer
  - product-manager
  - tpm
  - developer
  - generalist
triggers:
  - triage bug
  - bug triage
  - classify bug
  - prioritize bug
  - analyze bug
tags:
  - bug
  - triage
  - priority
  - severity
  - issue
  - project-management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Bug Triage

Triage a bug report by searching the codebase for related files and suggesting severity, priority, and assignee role. Automates the initial classification step of bug handling.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title` | Yes | Bug title or summary |
| `description` | Yes | Bug description with reproduction steps |
| `projectPath` | No | Path to search for related code (defaults to `.`) |
| `keywords` | No | Comma-separated keywords to search for in codebase (auto-extracted from title/description if not provided) |

## Example

### Basic triage

```bash
bash config/skills/agent/bug-triage/execute.sh '{"title":"Login form shows wrong error","description":"When entering an expired password, the form shows a generic error instead of asking to reset","projectPath":"."}'
```

### Triage with specific keywords

```bash
bash config/skills/agent/bug-triage/execute.sh '{"title":"Dashboard crashes on load","description":"TypeError when team data is null","projectPath":".","keywords":"dashboard,team,null,TypeError"}'
```

## How It Works

1. Extracts keywords from the bug title and description (or uses provided keywords)
2. Searches the codebase with grep for files containing those keywords
3. Classifies affected area: frontend, backend, config, or tests
4. Determines severity from keyword heuristics:
   - **Critical**: crash, data loss, security, vulnerability
   - **High**: error, broken, fails, exception, unable
   - **Medium**: wrong, incorrect, unexpected (default)
   - **Low**: slow, cosmetic, typo, minor
5. Suggests an assignee role based on affected area

## Output

JSON object with:
- `title` — the bug title
- `severity` — critical, high, medium, or low
- `priority` — P0, P1, P2, or P3
- `affectedArea` — frontend, backend, config, tests, or unknown
- `relatedFiles` — array of files matching the keywords (max 10)
- `suggestedAssignee` — recommended role for assignment
- `keywords` — keywords used for the search
- `triage` — human-readable triage summary

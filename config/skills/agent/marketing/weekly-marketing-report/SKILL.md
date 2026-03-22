---
name: weekly-marketing-report
description: Generates a structured weekly marketing performance report by reading content calendar data and summarizing posts by platform, status, and completion rate.
version: 1.0.0
category: marketing
skillType: claude-skill
assignableRoles:
  - analyst
triggers:
  - weekly report
  - marketing report
  - performance report
  - analytics report
tags:
  - marketing
  - analytics
  - report
  - weekly
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Weekly Marketing Report

Generates a structured weekly marketing performance report by reading content calendar data.

## Input Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Project path to find calendar data (default: `~/.crewly`) |
| `weekEndDate` | Yes | End date of the reporting week in `YYYY-MM-DD` format |
| `businessName` | Yes | Name of the business |
| `calendarPath` | No | Custom path to calendar.json (overrides default) |

## Example

```bash
bash execute.sh '{"projectPath":"/path/to/project","weekEndDate":"2026-03-29","businessName":"Acme AI"}'
```

## Output

Returns JSON with:
- `success`: boolean
- `report`: structured report object with summary, platformBreakdown, topPerformers, recommendations
- `markdown`: formatted markdown report string

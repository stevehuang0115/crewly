---
name: Aggregate Results
description: Compile results from all worker sub-tasks into a structured markdown report for the Orchestrator. Supports milestone, daily, and final report types.
version: 1.0.0
category: reporting
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - aggregate results
  - compile report
  - summarize tasks
  - generate report
tags:
  - reporting
  - aggregation
  - summary
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Aggregate Results

Compiles results from all worker sub-tasks into a structured markdown report for the Orchestrator. Supports milestone, daily, and final report types.

## When to Use

- When all sub-tasks for an objective are completed
- For periodic progress reports (daily/weekly)
- When the Orchestrator requests a status update
- Before escalating issues that affect overall objective completion

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/aggregate-results/execute.sh '{"teamId":"team-123","objective":"Build auth module","reportType":"final","taskPaths":["/project/.crewly/tasks/m1/done/task1.md","/project/.crewly/tasks/m1/done/task2.md"],"projectPath":"/path/to/project"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | No | Team ID for report labeling |
| `objective` | No | High-level objective being reported on |
| `reportType` | No | Report type: `milestone`, `daily`, `final` (default: `final`) |
| `taskPaths` | No | Array of task file paths to include |
| `projectPath` | No | Project path (used for team-progress API fallback) |
| `includeVerification` | No | Include verification results (default: `true`) |

## Report Types

| Type | Use Case | Typical Content |
|------|----------|----------------|
| `milestone` | End of a project milestone | Summary of all milestone tasks |
| `daily` | Daily standup reporting | Today's progress, blockers |
| `final` | Objective fully completed | Complete results, all deliverables |

## Output

### JSON Response
```json
{
  "success": true,
  "reportType": "final",
  "objective": "Build auth module",
  "reportFile": "/tmp/tl-report-team-123-1709769600.md",
  "timestamp": "2026-03-06T12:00:00Z",
  "stats": {
    "total": 5,
    "completed": 4,
    "failed": 1,
    "blocked": 0,
    "pending": 0
  }
}
```

### Markdown Report Format

The report is written to `reportFile` and follows the `[TL_REPORT]` tag convention:

```markdown
[TL_REPORT]
# Final Completion Report
**Objective**: Build auth module
...
## Summary
| Metric | Count |
|--------|-------|
| Total Tasks | 5 |
...
## Task Details
### [DONE] Implement JWT service
...
## Action Items
- 1 task(s) failed — review via handle-failure skill
```

## Sending the Report

After generating the report, send it to the Orchestrator:
```bash
bash {{SKILLS_PATH}}/agent/core/report-status/execute.sh '{"sessionName":"tl-session","status":"done","summary":"Objective complete: 4/5 tasks passed. Report at /tmp/tl-report-team-123.md"}'
```

## Related Skills

- `decompose-goal` — Original task creation
- `verify-output` — Task verification results
- `handle-failure` — Failed task handling

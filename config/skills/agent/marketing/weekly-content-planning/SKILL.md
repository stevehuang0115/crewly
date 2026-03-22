---
name: weekly-content-planning
description: Generates a weekly content calendar with 5-7 posts across specified platforms. Wraps the content-calendar skill to create batch entries for the upcoming week.
version: 1.0.0
category: marketing
skillType: claude-skill
assignableRoles:
  - strategist
triggers:
  - weekly content plan
  - plan next week
  - content planning
  - weekly calendar
tags:
  - marketing
  - content
  - planning
  - calendar
  - weekly
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Weekly Content Planning

Generates a weekly content calendar with 5-7 posts across specified platforms. Uses the content-calendar skill to persist each entry.

## Input Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `businessName` | Yes | Name of the business |
| `industry` | Yes | Business industry/vertical |
| `platforms` | Yes | JSON array of target platforms (e.g., `["x","linkedin"]`) |
| `contentMix` | No | JSON object with content type ratios (default: `{"educational":40,"engagement":30,"promotional":20,"community":10}`) |
| `weekStartDate` | Yes | Start date of the week in `YYYY-MM-DD` format |
| `projectPath` | No | Project path for calendar storage |
| `postCount` | No | Number of posts to plan (default: 5) |

## Example

```bash
bash execute.sh '{"businessName":"Acme AI","industry":"artificial intelligence","platforms":["x","linkedin","instagram"],"weekStartDate":"2026-03-23","projectPath":"/path/to/project"}'
```

## Output

Returns JSON with `success: true` and a `calendar` field containing the generated entries as a markdown table, plus an `entries` array with the raw entry data.

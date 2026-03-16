---
name: Content Calendar Manager
description: CRUD operations for content scheduling. Add, list, update, and query content calendar entries. Supports filtering by platform, status, date range, and content line (brand vs personal).
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - content-strategist
  - product-manager
  - generalist
triggers:
  - content calendar
  - schedule content
  - content plan
  - what to publish
  - next post
  - content schedule
tags:
  - content
  - calendar
  - scheduling
  - planning
  - marketing
  - editorial
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 10000
---

# Content Calendar Manager

Manage a content calendar with CRUD operations. Track planned content across platforms, schedule dates, and publication status.

## Storage

Calendar data is stored as a JSON file. Default location: `{projectPath}/.crewly/content/calendar.json`

## Actions

### `add` — Add a new content entry

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"add"` |
| `title` | Yes | Content title or headline |
| `platform` | Yes | `x`, `linkedin`, `xiaohongshu`, `substack`, `youtube`, `github`, `reddit` |
| `type` | No | `post`, `thread`, `article`, `video`, `image-text`, `newsletter`, `showcase`, `tutorial` (default: `post`) |
| `scheduledDate` | Yes | Target publish date in `YYYY-MM-DD` format |
| `status` | No | `idea`, `draft`, `ready`, `in-review`, `approved`, `published`, `archived` (default: `draft`) |
| `contentPath` | No | Path to the content file (markdown) |
| `line` | No | Content line: `crewly` (brand) or `personal` (Steve). Default: `crewly` |
| `topic` | No | Topic or brief description |
| `notes` | No | Internal notes |
| `tags` | No | JSON array of tags, e.g. `["ai-agent","security"]` |
| `projectPath` | No | Project path to determine calendar location |
| `calendarPath` | No | Custom calendar file path (overrides default) |

### `list` — List entries with filters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"list"` |
| `platform` | No | Filter by platform |
| `status` | No | Filter by status |
| `date` | No | Filter by exact date (`YYYY-MM-DD`) |
| `dateFrom` | No | Filter entries from this date |
| `dateTo` | No | Filter entries up to this date |
| `line` | No | Filter by content line (`crewly` or `personal`) |
| `limit` | No | Max entries to return (default: 50) |

### `update` — Update an entry

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"update"` |
| `id` | Yes | Entry ID to update |
| `status` | No | New status |
| `title` | No | New title |
| `scheduledDate` | No | New date |
| `contentPath` | No | New content file path |
| `notes` | No | New notes |
| `topic` | No | New topic |

### `next` — Get next content to publish

Returns the next entry with status `ready` or `approved` that is scheduled for today or earlier.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"next"` |
| `platform` | No | Filter by platform |

### `stats` — Calendar statistics

Returns counts by status, platform, and content line. Also shows overdue and this-week counts.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"stats"` |

## Examples

### Add a new X thread for Monday
```bash
bash execute.sh '{"action":"add","title":"AI Agent security - lessons from n8n CVEs","platform":"x","type":"thread","scheduledDate":"2026-03-03","status":"draft","line":"crewly","topic":"AI agent security","tags":["ai-agent","security","n8n"],"projectPath":"/path/to/project"}'
```

### List all content for next week
```bash
bash execute.sh '{"action":"list","dateFrom":"2026-03-03","dateTo":"2026-03-07","projectPath":"/path/to/project"}'
```

### List only draft X content
```bash
bash execute.sh '{"action":"list","platform":"x","status":"draft","projectPath":"/path/to/project"}'
```

### Mark content as published
```bash
bash execute.sh '{"action":"update","id":"cc-1709012345-42","status":"published","projectPath":"/path/to/project"}'
```

### Get next content to publish
```bash
bash execute.sh '{"action":"next","projectPath":"/path/to/project"}'
```

### Get calendar stats
```bash
bash execute.sh '{"action":"stats","projectPath":"/path/to/project"}'
```

## Status Workflow

```
idea → draft → ready → in-review → approved → published
                                                  ↓
                                              archived
```

- **idea**: Just a topic/concept, no content written
- **draft**: Content being written
- **ready**: Content complete, pending review
- **in-review**: Sent to Steve for review
- **approved**: Steve approved, ready to publish
- **published**: Live on the platform
- **archived**: Removed from active calendar

## Output

All actions return JSON with `success: true` and the relevant data. Errors return JSON to stderr with `error` field.

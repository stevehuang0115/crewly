---
name: Calendar List
description: List upcoming events on the owner's Google Calendar (via the Google Workspace grant held by Crewly Cloud). Defaults to the next 7 days on the primary calendar. Read-only.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - list calendar
  - check calendar
  - what's on my calendar
  - upcoming meetings
tags:
  - google
  - calendar
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Calendar List

```bash
bash execute.sh                                   # next 7 days, primary calendar
bash execute.sh --from 2026-09-18T00:00:00Z --to 2026-09-19T00:00:00Z --max 20
bash execute.sh '{"calendarId":"team@group.calendar.google.com","from":"…","to":"…"}'
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--from` (`from`) | no | ISO 8601 lower bound; default now |
| `--to` (`to`) | no | ISO 8601 upper bound; default now + 7 days |
| `--calendar` (`calendarId`) | no | Calendar id; default `primary` |
| `--max` (`max`) | no | Result cap, default 50, max 250 |

## Output

```json
{"count":2,"events":[{"id":"…","summary":"Standup","start":{"dateTime":"2026-09-18T09:00:00+08:00"},"end":{"dateTime":"…"},"attendees":[{"email":"ann@example.com","responseStatus":"accepted"}],"htmlLink":"https://…"}]}
```

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace.

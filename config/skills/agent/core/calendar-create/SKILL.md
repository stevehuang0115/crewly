---
name: Calendar Create
description: Create an event on the owner's Google Calendar (via the Google Workspace grant held by Crewly Cloud) — timed or all-day, with optional description and attendees. Attendees receive an invitation from the owner, so confirm before inviting others.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - create event
  - schedule meeting
  - add to calendar
  - book a meeting
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

# Calendar Create

```bash
bash execute.sh --summary "Design review" --start 2026-09-20T14:00:00 --end 2026-09-20T15:00:00 \
  --timezone Asia/Shanghai --description "Walk through v2" --attendee ann@example.com
bash execute.sh --summary "Offsite" --start 2026-10-01 --end 2026-10-02      # all-day (end is exclusive)
bash execute.sh '{"summary":"Standup","start":"2026-09-21T09:00:00Z","end":"2026-09-21T09:15:00Z"}'
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--summary` (`summary`) | yes | Event title |
| `--start` (`start`) | yes | ISO 8601 date-time, or `YYYY-MM-DD` for all-day |
| `--end` (`end`) | yes | ISO 8601 date-time, or `YYYY-MM-DD` (exclusive) for all-day |
| `--timezone` (`timezone`) | no | IANA zone applied to start/end without an offset |
| `--description` (`description`) | no | Body text |
| `--attendee` (`attendees`) | no | Email; repeat for several (JSON: array or comma list) |
| `--calendar` (`calendarId`) | no | Calendar id; default `primary` |

## Output

```json
{"success":true,"id":"…","summary":"Design review","start":{"dateTime":"…","timeZone":"Asia/Shanghai"},"end":{…},"htmlLink":"https://…","attendees":[{"email":"ann@example.com","responseStatus":"needsAction"}]}
```

## Failures

Missing `--summary` / `--start` / `--end` → `{"error":"Missing required parameter: …"}` on stderr, exit 1.
`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1) when the owner has not connected Google Workspace;
`reason` `validation` when Google cannot parse a time.

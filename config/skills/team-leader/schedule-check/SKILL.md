---
name: Schedule Check (TL)
description: Schedule a future check-in or reminder. TL can only target self or subordinate workers (hierarchy-validated).
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - schedule check
  - remind me
  - check in later
  - follow up
tags:
  - scheduling
  - monitoring
  - reminder
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Schedule Check (Team Leader)

Schedule a future check-in reminder. Unlike the orchestrator version, this skill enforces hierarchy — you can only schedule checks targeting yourself or your subordinate workers.

## Usage

### Self-reminder (default target)
```bash
bash config/skills/team-leader/schedule-check/execute.sh '{"minutes":5,"message":"Check worker progress on feature X","sessionName":"my-session-name"}'
```

### Target a specific subordinate
```bash
bash config/skills/team-leader/schedule-check/execute.sh '{"minutes":10,"message":"Status update needed","target":"worker-session-name","teamId":"team-123","tlMemberId":"tl-member-id"}'
```

### Recurring check
```bash
bash config/skills/team-leader/schedule-check/execute.sh '{"minutes":10,"message":"Periodic progress check","recurring":true,"maxOccurrences":6}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `minutes` | Yes | Delay in minutes before the check fires |
| `message` | Yes | Reminder message text |
| `target` | No | Target session name (defaults to self). Must be self or a subordinate |
| `sessionName` | No | Caller's own session name. Used as fallback when `CREWLY_SESSION_NAME` env var is not set (e.g. Gemini CLI) |
| `recurring` | No | When `true`, the check repeats every `minutes` interval (default: `false`) |
| `maxOccurrences` | No | Max times a recurring check fires (default: unlimited). Only for `recurring: true` |
| `teamId` | Conditional | Required when targeting a subordinate (for hierarchy validation) |
| `tlMemberId` | Conditional | Required when targeting a subordinate (your member ID for hierarchy validation) |

## Hierarchy Rules

- **Self target**: Always allowed — no `teamId`/`tlMemberId` needed. Pass `sessionName` if `CREWLY_SESSION_NAME` env var is not available
- **Subordinate target**: Requires `teamId` and `tlMemberId`. The script verifies the target's `parentMemberId` matches your `tlMemberId`
- **Non-subordinate target**: Rejected with hierarchy violation error

## Output

JSON with the scheduled check ID and fire time.

## Best Practices

- **Use `maxOccurrences`** for time-bounded tasks to prevent stale schedules
- **Include worker name and task context** in the message for quick triage when the check fires
- **Prefer self-targeted checks** — schedule reminders to yourself to review worker status rather than interrupting workers directly

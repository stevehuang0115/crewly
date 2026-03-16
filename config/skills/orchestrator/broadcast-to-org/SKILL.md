---
name: Broadcast to Organization
description: Send a message to all Team Leaders within a specific organization (parent team and its child teams).
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - broadcast to org
  - message org leaders
  - notify organization
tags:
  - communication
  - broadcast
  - organization
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Broadcast to Organization

Send a message to all Team Leaders within a specific organization. Given a parent team ID, this skill finds all child teams, identifies their leaders, and delivers the message to each leader's session.

## Usage

```bash
bash config/skills/orchestrator/broadcast-to-org/execute.sh '{"parentTeamId":"org-team-id","message":"Please submit your weekly status reports by EOD"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `parentTeamId` | Yes | The ID of the parent/organization team |
| `message` | Yes | The message to send to all TLs in the organization |

## How It Works

1. Fetches all teams from the API
2. Filters child teams whose `parentTeamId` matches the given ID
3. For each child team, finds leaders using (in priority order):
   - `leaderIds` array on the team
   - Members with `hierarchyLevel == 1`
   - Members with `role == "team-leader"` (fallback)
4. Delivers the message to each leader's session via `/terminal/{session}/deliver`

## Output

JSON with delivery summary:

```json
{
  "sent": 3,
  "failed": 0,
  "skipped": 1,
  "childTeams": 4,
  "details": [
    {"team": "Frontend", "session": "crewly-frontend-tl", "status": "sent"},
    {"team": "Backend", "session": "crewly-backend-tl", "status": "sent"},
    {"team": "QA", "status": "skipped", "reason": "no leader found"}
  ],
  "message": "Broadcast to organization complete"
}
```

## Best Practices

- Use this for organization-wide announcements like deadlines, priority changes, or standup reminders
- For individual team communication, use `send-message` or `delegate-task` instead
- Check the `skipped` count — teams without leaders won't receive the message

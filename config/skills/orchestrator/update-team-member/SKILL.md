---
name: update-team-member
description: Update a team member's properties — name, role, runtimeType, systemPrompt — via the team membership API.
version: 1.0.0
category: team
skillType: claude-skill
assignableRoles:
  - orchestrator
tags:
  - team
  - member
  - admin
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# update-team-member

Update a team member's properties including name, role, runtimeType, systemPrompt, and other attributes.

## Usage

```bash
bash config/skills/orchestrator/update-team-member/execute.sh '{"teamId":"<team-uuid>","memberId":"<member-uuid>","runtimeType":"crewly-agent"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| teamId | Yes | Team UUID or "orchestrator" |
| memberId | Yes | Member UUID |
| name | No | New display name |
| role | No | New role (e.g., "developer", "pm") |
| runtimeType | No | Runtime type: "claude-code", "gemini-cli", "codex-cli", "crewly-agent" |
| systemPrompt | No | New system prompt text |

## Examples

```bash
# Change runtime type
bash config/skills/orchestrator/update-team-member/execute.sh '{"teamId":"817a1aeb","memberId":"member-001","runtimeType":"gemini-cli"}'

# Update name and role
bash config/skills/orchestrator/update-team-member/execute.sh '{"teamId":"817a1aeb","memberId":"member-001","name":"New Name","role":"developer"}'
```

## Notes

- When only `runtimeType` is provided, the dedicated `/runtime` endpoint is used for stricter validation
- For other fields, the general member update endpoint is used
- The member must exist in the specified team

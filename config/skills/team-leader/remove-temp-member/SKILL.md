---
name: Remove Temporary Member (TL)
description: "Remove one of your team's temporary members early: its session is stopped and it leaves the team, freeing a place in the temporary headcount. Permanent members are refused."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - remove temporary member
  - temporary member is done
tags:
  - agent
  - management
  - team
  - capacity
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Remove Temporary Member (TL Version)

Temporary members are removed automatically when their work is accepted or they sit unused, so you rarely need this. Use it when you want the place in the headcount back now (to add a different role), or the work was dropped.

## Usage

```bash
bash {{TL_SKILLS_PATH}}/remove-temp-member/execute.sh --member "Temp-Developer-1"
bash {{TL_SKILLS_PATH}}/remove-temp-member/execute.sh --member "Temp-Developer-1" --reason "launch moved to next month"
```

## Parameters

| Flag | JSON field | Required | Description |
|------|-----------|----------|-------------|
| `--member` / `-m` | `member` | Yes | Name, member id or session name of the temporary member |
| `--reason` / `-r` | `reason` | No | Why it goes (recorded) |
| `--force` | `force` | No | Remove it although it is in the middle of a turn or still holds work |
| `--team` / `-g` | `teamId` | No | Your team id. Default: your own team |

## Rules

- Only temporary members. A permanent member is refused (`not_temporary`): only the owner removes those.
- A member that still holds work or is mid-turn is refused (`member_busy`). Reassign or cancel its work first; `--force` only when the work no longer matters.

## Output

`{"success":true,"data":{"removed":true,"member":{"id":"member-...","name":"Temp-Developer-1","role":"developer"},"headcount":{"used":0,"limit":2}}}`

## Related Skills

- `add-temp-member` — add a temporary member
- `request-seat` — ask the owner to make the seat permanent instead

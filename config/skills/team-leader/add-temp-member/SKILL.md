---
name: Add Temporary Member (TL)
description: "Add a temporary member to your own team when there is more work than hands. Counts against the team's temporary agent headcount (set by the owner, default 2). The member starts when you assign it work and is removed automatically once its work is accepted or it sits unused."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - add temporary member
  - not enough hands
  - every member is busy
  - need more people
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
    timeoutMs: 30000
---

# Add Temporary Member (TL Version)

When every member is busy, or the work needs hands your team does not have, do not quietly do it all yourself. Add a temporary member and delegate to it.

Each team has a **temporary agent headcount**: how many temporary members it may have at the same time. The owner sets it (default 2; 0 turns it off). Within it you decide yourself; no owner approval is needed.

## Usage

```bash
bash {{TL_SKILLS_PATH}}/add-temp-member/execute.sh --role developer --reason "two launches this week, every member is busy"

# Optional: a name, and the work item it is for
bash {{TL_SKILLS_PATH}}/add-temp-member/execute.sh --role designer --reason "launch images, nobody free" --name "Kai" --work-item <WorkItem id>
```

## Parameters

| Flag | JSON field | Required | Description |
|------|-----------|----------|-------------|
| `--role` | `role` | Yes | A known working role (`developer`, `designer`, `qa`, ...). Lead roles are refused |
| `--reason` / `-r` | `reason` | Yes | Why the team needs one more pair of hands now. Recorded; the owner sees it if you later ask for a permanent seat |
| `--name` / `-n` | `name` | No | Member name. Default: `Temp-<Role>-<n>` |
| `--work-item` | `workItemId` | No | The work it is for. It is removed 30 idle minutes after that work is accepted |
| `--team` / `-g` | `teamId` | No | Your team id. Default: your own team |

## What happens

- The member joins your team as an ordinary member on the default member model, marked temporary.
- It **starts when you assign it work**: `delegate-task --to <sessionName from the output> --task "..."`.
- It is **removed automatically** when it is not in the middle of a turn, holds no open work, and one of: its work item (`--work-item`) was accepted and it has been idle for 30 minutes; it had no work for 6 hours; it is 3 days old. Work it reported done that you have not verified yet keeps it until the 3-day limit. A busy member is never removed. You get one short `[TEMP MEMBER]` note.
- Remove one early with `remove-temp-member`.

## When it is refused

| `code` | Meaning | What to do |
|--------|---------|-----------|
| `temp_headcount_full` | The headcount is used up | Use one of the temporary members listed, remove one that is done, or `request-seat` |
| `temp_headcount_disabled` | The owner set the headcount to 0 | `request-seat` |
| `memory_pressure` | The machine is short of memory | Wait and try again; `request-seat` if this keeps happening |
| `unknown_role` / `role_not_allowed` | Not a working role | Use one of the roles the message lists |
| `not_team_lead` | You do not lead that team | Only a team's own lead adds members to it |

When the same role was opened three times in 14 days, the output adds a `hint`: this need keeps coming back, so ask the owner for a permanent seat with `request-seat`.

## Output

`{"success":true,"data":{"member":{"id":"member-...","name":"Temp-Developer-1","role":"developer","sessionName":"marketing-temp-developer-1-member-1"},"temporary":{"reason":"...","expiresAt":"..."},"headcount":{"used":1,"limit":2},"delegate":"bash .../delegate-task/execute.sh --to marketing-temp-developer-1-member-1 --task \"<the work>\"","note":"..."}}`

## Related Skills

- `delegate-task` — give the temporary member its work (this starts it)
- `remove-temp-member` — remove one early
- `request-seat` — ask the owner for a permanent seat

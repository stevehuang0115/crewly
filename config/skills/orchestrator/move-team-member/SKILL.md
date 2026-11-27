---
name: Move Team Member
description: "Move an existing agent from one team to another, keeping its session name, memory and open work. Not for moving a whole team to another machine (that is move-team)."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - move team member
  - move agent to another team
  - transfer member
  - split the team
  - 调到另一个团队
tags:
  - team
  - management
  - members
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Move Team Member

Move one agent to another team of this machine. Use it when the owner
reorganises teams ("move Nova to Growth", splitting a team in two). It is the
same agent afterwards: same session name, memory, name, role and model
settings. Never delete a member and add a new one to do this: the new one has
no memory and no history.

## Usage

```bash
bash config/skills/orchestrator/move-team-member/execute.sh --member Nova --to Growth
# the name is on two teams: say which one it leaves (or pass the session name)
bash config/skills/orchestrator/move-team-member/execute.sh --member Kai --from Core --to Growth
# JSON form
bash config/skills/orchestrator/move-team-member/execute.sh '{"member":"core-nova-1a2b3c4d","to":"Growth"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--member` / `member` | Yes | Session name, member id or name |
| `--to` / `to` | Yes | Target team name or id (it must exist) |
| `--from` / `from` | No | Source team, when the name is not unique |
| `--allow-lead` / `allowLead` | No | Move the source team's lead anyway |

## What follows the agent

Its open work items, followups and watchers, cron tasks, open decision
questions, saved prompt and session restore record. The old team keeps its own
schedules and its history.

## Refusals (nothing changes)

| `code` | What to do |
|--------|------------|
| `member_busy` | It is working or starting up. Wait until it is idle, or stop it, then move. |
| `member_is_lead` | Give the old team another lead first (`set-team-lead`). Use `--allow-lead` only when the owner wants that team left without one, or is moving its lead on purpose. A target that already names the member lead needs no flag. |
| `member_is_temporary` | Temporary members belong to the team that asked for them. |
| `same_team`, `already_in_target` | Nothing to move, or the target already lists it. |
| `target_not_found`, `target_archived` | Create or restore the target team first. |
| `orchestrator` | The orchestrator and its team cannot be moved. |

## Output

JSON with `member`, `from`, `to`, `updated` (the ids changed), `warnings`,
`restartRequired` and a one-line `summary`. Read the warnings and act on them.
When `restartRequired` is true the running session still has the old team's
context: restart the agent (`stop-agent`, then `start-agent` with the new team
id). Tell the owner in one line who is on which team now. Only the owner and
the orchestrator may move members; an agent calling this gets 403.

---
name: Stop Agent (TL)
description: "Stop a worker agent within the Team Leader's scope: a member whose parentMemberId is the TL, or a parentless member of a team the TL leads."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - stop agent
  - stop worker
  - deactivate worker
  - shutdown worker
tags:
  - agent
  - management
  - lifecycle
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Stop Agent (TL Version)

Stops a worker agent within the Team Leader's subordinate scope. Validates hierarchy before stopping — the target worker's `parentMemberId` must match the TL's `memberId`.

## When to Use

- When a worker is no longer needed for current objectives
- When scaling down the sub-team after task completion
- When a worker is stuck and needs to be restarted (stop then start)

## Usage

```bash
bash {{TL_SKILLS_PATH}}/stop-agent/execute.sh '{"teamId":"{{TEAM_ID}}","memberId":"worker-member-uuid","tlMemberId":"{{MEMBER_ID}}"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `memberId` | Yes | The target worker's member UUID |
| `tlMemberId` | Yes | The TL's own member ID for hierarchy validation |

## Hierarchy Validation

The script fetches team data and allows the stop when:
- the member's `parentMemberId` is the TL's `memberId` (a subordinate), or
- the member has no `parentMemberId`, and the TL is a leader of the same team (listed in the team's `leaderIds`, or `canDelegate` on its own member record).

It refuses members of other teams, members whose parent is someone else, and parentless members of a team the TL does not lead.

## Differences from Orchestrator stop-agent

| Aspect | Orchestrator | Team Leader |
|--------|-------------|-------------|
| Scope | Any agent in any team | Only subordinates |
| Hierarchy check | None | Subordinates, or parentless members of the TL's own team |
| Extra parameter | None | `tlMemberId` required |

## Output

JSON confirmation with agent shutdown status, same format as orchestrator stop-agent.

## Related Skills

- `start-agent` — Start a subordinate worker
- `delegate-task` — Assign tasks to running workers
- `handle-failure` — Handle worker failures (may need stop + restart)

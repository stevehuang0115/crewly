---
name: Stop Agent (TL)
description: "Stop a worker agent within the Team Leader's subordinate scope. Validates that the target worker's parentMemberId matches the TL's memberId before stopping."
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

The script fetches team data and validates:
- The target member exists in the team
- The member's `parentMemberId` matches the TL's `memberId`

If validation fails, the stop is rejected with a hierarchy violation error. TLs can only stop their own subordinates — not agents in other teams or under other TLs.

## Differences from Orchestrator stop-agent

| Aspect | Orchestrator | Team Leader |
|--------|-------------|-------------|
| Scope | Any agent in any team | Only subordinates |
| Hierarchy check | None | Validates parentMemberId |
| Extra parameter | None | `tlMemberId` required |

## Output

JSON confirmation with agent shutdown status, same format as orchestrator stop-agent.

## Related Skills

- `start-agent` — Start a subordinate worker
- `delegate-task` — Assign tasks to running workers
- `handle-failure` — Handle worker failures (may need stop + restart)

---
name: Start Agent (TL)
description: "Start a worker agent within the Team Leader's subordinate scope. Validates that the target worker's parentMemberId matches the TL's memberId before starting."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - start agent
  - start worker
  - activate worker
  - boot worker
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
    timeoutMs: 60000
---

# Start Agent (TL Version)

Starts a worker agent within the Team Leader's subordinate scope. Validates hierarchy before starting — the target worker's `parentMemberId` must match the TL's `memberId`.

## When to Use

- When a worker needs to be activated for task assignment
- After a worker was previously stopped and needs to be restarted
- When scaling up the sub-team for a new objective

## Usage

```bash
bash {{TL_SKILLS_PATH}}/start-agent/execute.sh '{"teamId":"{{TEAM_ID}}","memberId":"worker-member-uuid","tlMemberId":"{{MEMBER_ID}}"}'
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

If validation fails, the start is rejected with a hierarchy violation error. TLs can only start their own subordinates — not agents in other teams or under other TLs.

## Differences from Orchestrator start-agent

| Aspect | Orchestrator | Team Leader |
|--------|-------------|-------------|
| Scope | Any agent in any team | Only subordinates |
| Hierarchy check | None | Validates parentMemberId |
| Extra parameter | None | `tlMemberId` required |

## Output

JSON confirmation with agent startup status, same format as orchestrator start-agent.

## Related Skills

- `stop-agent` — Stop a subordinate worker
- `delegate-task` — Assign tasks to workers after starting them

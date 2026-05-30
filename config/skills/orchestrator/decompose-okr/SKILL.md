---
name: Decompose OKR
description: Decompose a parent Mission (OKR) into child OKRs one cascade tier down (company→team→project) as a PROPOSAL. The runtime drafts the child objectives + Key Results; the skill submits them to the backend as pending_approval. Children are NOT active until the human owner approves. Output includes an [APPROVE] block naming the parent and proposed children for the owner's decision.
version: 1.0.0
category: planning
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
triggers:
  - decompose okr
  - cascade okr
  - propose child okrs
  - break okr into team okrs
  - okr decomposition
tags:
  - okr
  - cascade
  - mission
  - planning
  - proposal
  - approval
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Decompose OKR (Cascade)

Decomposes a parent Mission's OKR into **child OKRs one cascade tier down** —
company → team → project. Unlike `decompose-mission` (which breaks a Mission into
executable tasks/WorkItems), this skill produces **child Missions + Key Results**
as a **proposal** that the human owner (Steve) must approve before they become
cascade-active.

The agent runtime does the thinking — this skill assembles the parent context and
collects the structured proposal. It does NOT auto-activate the children: every
decomposition flows through the approve/reject gate.

## When to run

At the start of an OKR period, a team-leader / product-manager agent runs this
against an **approved** parent Mission to draft the next tier of OKRs.

## Usage

```bash
bash config/skills/orchestrator/decompose-okr/execute.sh \
  --mission-id <parent-uuid> \
  [--project-path /path/to/project]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--mission-id` | Yes | UUID of the **parent** Mission to decompose (must be approved) |
| `--project-path` | No | Absolute path to the project root (context only) |

## Cascade rule

The child level is exactly one tier below the parent:

| parent level | child level | `projectId` required on each child |
|---|---|---|
| company | team | no |
| team | project | yes |
| project | — | (cannot decompose further) |

## Output

The skill instructs the runtime to output a proposal JSON and POST it to
`POST /api/missions/:id/decompose-okr`:

```json
{
  "children": [
    {
      "objective": "Child OKR objective for the level below",
      "currentStrategy": "How this child will pursue the objective",
      "successCriteria": ["narrative success criterion"],
      "projectId": "required-only-when-child-is-project-level",
      "keyResults": [
        {
          "title": "Measurable Key Result",
          "metricType": "number",
          "baseline": 0,
          "target": 100,
          "unit": "signups"
        }
      ]
    }
  ]
}
```

The backend creates each child Mission with `approval.state = 'pending_approval'`,
`parentMissionId` = the parent, `level` = parent level + 1, and creates the Key
Results under each child. Children are excluded from roll-up and autonomous
execution until approved.

The skill then emits an `[APPROVE]` block naming the parent and the proposed
children so the owner can approve (`POST /api/missions/:childId/approve`) or
reject with a reason (`POST /api/missions/:childId/reject` `{ "reason": "..." }`).

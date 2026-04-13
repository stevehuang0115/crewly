---
title: "System Upgrade: Team Organization Model (April 2026)"
tags: [architecture, organization, team, ownership, service-contract, autonomy, evergreen]
scope: project
category: architecture
createdAt: "2026-04-13T00:00:00Z"
---

# Team Organization Model Upgrade

## Overview

The team system has been upgraded with a formal organization model. Teams are no longer just "groups of agents with roles" — they are now **delivery units with defined ownership, capabilities, and enforced authority boundaries**.

## New Concepts

### ServiceContract (Team-level)

Every team can now declare what work it accepts and avoids:

```typescript
team.serviceContract = {
  accepts: ["frontend features", "UI bugfixes"],
  avoids: ["database migrations", "security incident response"],
  expectedOutput: ["PR with tests", "deployment notes"],
  slaHint: { simpleTask: "same day", mediumTask: "1-3 days" }
};
```

**Use this for task routing** — when deciding which team should handle a task, check their `serviceContract.accepts` and `serviceContract.avoids`.

### OwnershipScope (Team-level and Member-level)

Defines what domains, deliverables, and areas a team or individual owns:

```typescript
// Team level — what the whole team owns
team.ownershipScope = { domains: ["frontend"], deliverables: ["feature_delivery", "ui_quality"] };

// Member level — what a specific person owns
member.ownershipScope = { domains: ["frontend"], areas: ["checkout-flow", "shared-components"] };
```

**Tasks within ownership scope**: handle autonomously.
**Tasks outside ownership scope**: escalate or defer to the appropriate owner.

### JobTitle + JobDescription (Member-level)

Every team member can now have a specific job title and description beyond their base role:

```typescript
member.jobTitle = "Frontend Tech Lead";
member.jobDescription = "Owns frontend code quality and architecture decisions";
member.responsibilityType = "quality_owner"; // or "delivery_owner" | "system_owner"
```

**This is injected into the agent's system prompt** under "Your Position" and "Your Ownership Scope" sections.

### ResponsibilityType

Defines how a TL or member is accountable:
- `delivery_owner` — responsible for shipping features on time
- `quality_owner` — responsible for code quality, testing, and verification
- `system_owner` — responsible for system reliability and performance

## autonomyLevel is Now a Hard Constraint

Previously, `autonomyLevel` was only a prompt instruction. **Now it is enforced by SkillPermissionService** — skills are actually blocked, not just "suggested to avoid".

| Level | Allowed | Blocked |
|-------|---------|---------|
| `directed` | Execution skills (code-review, testing, report-status) | delegate-task, decompose-goal, start-agent, stop-agent, design-team |
| `bounded` | Above + delegation within scope | deploy-to-prod, design-team, stop-agent |
| `domain_autonomous` | Almost everything | deploy-to-prod |

**Orchestrator role bypasses all checks.**

## New Skills

### For Orchestrator

- **`design-team`** — Create a team from natural language description. Loads available templates, roles, and existing teams as context. The runtime generates a structured team config JSON.
  ```bash
  bash config/skills/orchestrator/design-team/execute.sh --description "Build a frontend team with 3 people"
  ```

- **`decompose-mission`** — Break a Mission/OKR into concrete tasks with dependencies. Runtime does the thinking, Crewly handles WorkItem creation.
  ```bash
  bash config/skills/orchestrator/decompose-mission/execute.sh --mission-id <uuid> --project-path /path
  ```

### For Team Leader

- **`design-checklist`** — Generate acceptance checklist BEFORE task execution. Must be approved by superior before TL proceeds with delegation.
  ```bash
  bash config/skills/team-leader/design-checklist/execute.sh --objective "Build auth" --task-id task-123
  ```

## New Services

### AgentAutoClaimService
Automatically assigns work to idle agents. Listens to `agent:idle` and `task:done` events, scores available WorkItems using `computeAgentScore()`, and claims the best match.

### MissionExecutorService
Lightweight Mission lifecycle manager. Processes decomposition results into WorkItems, tracks progress, supports pause/resume. No LLM calls — the runtime handles thinking via skills.

### TLAutoVerifyService
When a worker completes a task, automatically finds their TL via hierarchy (`parentMemberId`) and sends a verification request with the pre-approved checklist.

### EscalationRouterService
Routes escalations to the correct target:
- `target: 'team_lead'` → message to TL agent
- `target: 'human'` → Slack notification + pause task + persistent record
- Resolution via `POST /api/escalations/:id/resolve`

### SkillPermissionService
Hard enforcement gate for `autonomyLevel`. Blocks skills before the agent sees them, not just via prompt instruction.

## New API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/missions/:id/decompose` | Submit decomposition result from skill |
| `GET /api/missions/:id/progress` | Real-time Mission progress snapshot |
| `POST /api/missions/:id/pause` | Freeze Mission execution |
| `POST /api/missions/:id/resume` | Resume execution |
| `POST /api/task-management/:taskId/checklist` | Submit acceptance checklist |
| `POST /api/task-management/:taskId/checklist/approve` | Approve checklist |
| `GET /api/task-management/:taskId/checklist` | Get current checklist |
| `GET /api/escalations` | List pending human escalations |
| `POST /api/escalations/:id/resolve` | Resolve human escalation |

## WorkItem Status Machine (Extended)

New states for acceptance/verification flow:

```
queued → proposed → accepted → running → done_by_worker → verified
                  → rejected → queued (re-scope)

running → escalated → queued | cancelled
```

Key transitions are now role-gated via `TRANSITION_PERMISSIONS`:
- Only agents can accept/reject proposals
- Only TL can verify/reject worker output
- Only agents can escalate

## Task Dependency System

WorkItems can now declare dependencies via `metadata._blockedBy`:
- Dependent tasks start with status `blocked`
- When a dependency completes, `unlockDependentWorkItems()` removes it
- When all dependencies cleared → `blocked → queued` (enters pool for claiming)

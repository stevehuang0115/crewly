---
title: "How to Create and Configure Teams (Template Guide)"
tags: [team, template, creation, organization, how-to, evergreen]
scope: project
category: pattern
createdAt: "2026-04-13T00:00:00Z"
---

# Team Creation & Configuration Guide

## Three Ways to Create a Team

### 1. Natural Language (Recommended)

Tell the orchestrator what you need:

> "帮我建一个做前端的团队，3个人"
> "Create a backend team for API development"

The orchestrator uses the `design-team` skill to generate a complete team config including ownership, service contract, and job descriptions.

### 2. From Template

Use a predefined template:

```bash
POST /api/teams/from-template
{
  "templateId": "dev-fullstack",
  "teamName": "Product Team",
  "nameOverrides": { "team-leader": "Sam", "developer": "Leo" }
}
```

Available templates: `GET /api/templates`

### 3. Manual Creation

```bash
POST /api/teams
{
  "name": "Frontend Team",
  "hierarchical": true,
  "mission": "Build and maintain the customer-facing UI",
  "ownershipScope": { "domains": ["frontend"], "deliverables": ["feature_delivery"] },
  "serviceContract": {
    "accepts": ["frontend features", "UI bugfixes"],
    "avoids": ["backend API changes"],
    "expectedOutput": ["PR with tests"]
  },
  "members": [...]
}
```

## Template 5-Layer Structure

Templates define teams with these conceptual layers:

| Layer | Fields | Purpose |
|-------|--------|---------|
| **Identity** | name, description, category, mission | Who this team is |
| **Capability** | ownershipScope, serviceContract, roles[].defaultSkills | What they can do |
| **Organization** | roles, hierarchical, reportsTo, hierarchyLevel | How they're organized |
| **Governance** | verificationPipeline, autonomyLevel, budget, qualityGate | How they're constrained |
| **Routing** | serviceContract.accepts/avoids, ownershipScope.domains | How work finds them |

## Key Fields for Each Member

| Field | Example | Purpose |
|-------|---------|---------|
| `role` | "developer" | Base capability set |
| `jobTitle` | "Frontend Tech Lead" | Specific position in team |
| `jobDescription` | "Owns frontend quality" | What they're responsible for |
| `ownershipScope` | `{domains: ["frontend"]}` | What they own |
| `responsibilityType` | "quality_owner" | How they're accountable |
| `autonomyLevel` | "bounded" | What they're allowed to do |

## TL Checklist Alignment Flow

When a TL receives a new objective:

1. Run `design-checklist` → generates acceptance criteria
2. Submit checklist → `POST /api/task-management/:taskId/checklist`
3. Superior approves → `POST /api/task-management/:taskId/checklist/approve`
4. TL proceeds with `decompose-goal` + `delegate-task`
5. Workers complete → TLAutoVerifyService triggers verification
6. TL uses approved checklist in `verify-output`

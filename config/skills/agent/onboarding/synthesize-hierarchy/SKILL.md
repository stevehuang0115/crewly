---
name: Synthesize Hierarchy
description: Plan and create a NESTED team hierarchy (parent coordination team + per-stream child teams) for a complex multi-stream goal. Use INSTEAD of recommend-team/materialize-team when the goal names 2+ parallel work-streams (e.g. frontend + backend + DevOps). Onboarding-only.
version: 0.1.0
category: onboarding
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - synthesize hierarchy
  - create sub-teams
  - nested teams
  - parallel teams
tags:
  - onboarding
  - hierarchy
  - sub-teams
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Synthesize Hierarchy (Onboarding v3 — P3)

For a COMPLEX goal with 2+ parallel work-streams (e.g. "build a SaaS with a
React frontend, a Node backend, and DevOps"), a single flat team is the wrong
shape. This skill:

1. **Plan** (default): detects the parallel streams in the goal and returns a
   `HierarchyPlan` — a parent coordination team + one child team per stream.
   Nothing is created. **Show the plan to the user and get approval first**
   (a new-team launch is a Commitment — it ALWAYS needs explicit approval).
2. **Materialize** (`--materialize '<planJSON>'`): instantiate the approved
   plan — parent team first, then each child team linked via `parentTeamId`.
   All teams are LIVE (real members, prompts, hierarchy) via the same
   provisioning path as materialize-team.

If the plan comes back with NO children (fewer than 2 streams detected), fall
back to the normal `recommend-team` → `materialize-team` flow — one team is
sufficient.

## Usage

```bash
# 1. Plan (pure — show the result to the user for approval):
bash execute.sh --industry "build a SaaS: React frontend, Node API backend, DevOps" --scale small-team

# 2. After the user approves, materialize the exact plan you showed:
bash execute.sh --materialize '<the plan JSON from step 1>'
```

## Parameters

| Flag | Required | Description |
|---|---|---|
| `--industry` | for plan | Free-text goal/domain description |
| `--scale` | for plan | `solo` \| `small-team` \| `company` |
| `--tasks` | no | JSON array of `{name, tier}` tasks |
| `--max-subteams` | no | Branching cap (default 5) |
| `--materialize` | for create | The approved plan JSON — instantiates it |

This skill is callable **only when orc is in `'onboarding'` mode**.

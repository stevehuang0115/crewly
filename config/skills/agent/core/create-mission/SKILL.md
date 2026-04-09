---
name: Create Mission
description: "Create a new Mission with objective, success criteria, and strategy."
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
triggers:
  - create mission
  - new mission
  - define mission
  - set objective
tags:
  - mission
  - objective
  - strategy
  - planning
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Create Mission

Create a new Mission via the `/api/missions` endpoint. Missions define high-level objectives with success criteria and strategy, enabling team leads and agents to autonomously set goals.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--objective` / `-o` | `objective` | Yes | The mission objective (what to achieve) |
| `--owner-team-id` / `-t` | `ownerTeamId` | Yes | Team ID that owns this mission |
| `--success-criteria` / `-c` | `successCriteria` | Yes | JSON array of success criteria strings |
| `--strategy` / `-s` | `currentStrategy` | Yes | Description of the current strategy |
| `--cadence` | `cadence` | No | Cadence string (e.g. `daily`, `weekly`) |
| `--policy` | `policy` | No | JSON object for mission policy overrides |

## Examples — CLI Flags (preferred)

```bash
# Create a basic mission
bash execute.sh --objective "Deliver V3 architecture" \
  --owner-team-id "817a1aeb-b04e-45dd-bdbc-be5cbc4345f1" \
  --success-criteria '["All V3 services implemented","100% test coverage","Zero regressions"]' \
  --strategy "Incremental migration with parallel V2 support"

# Create with cadence and policy
bash execute.sh --objective "Weekly code quality audit" \
  --owner-team-id "team-123" \
  --success-criteria '["All critical issues resolved","Test coverage above 80%"]' \
  --strategy "Automated scanning with manual review" \
  --cadence "weekly" \
  --policy '{"maxBudget":1000,"autoEscalate":true}'
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"objective":"Ship V3","ownerTeamId":"team-123","successCriteria":["All services migrated"],"currentStrategy":"Incremental migration"}'
```

## Output

JSON response from the missions API with the created Mission object, including its generated ID, status, and policy.

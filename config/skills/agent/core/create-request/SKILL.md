---
name: Create Request
description: "Create a V3 Request from a user message that the orchestrator has determined to be actionable work."
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
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
  - create request
  - log request
  - new request
  - track request
tags:
  - v3
  - request
  - tracking
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Create Request

Create a V3 Request entity to track actionable user work. This skill is called by the orchestrator (or any agent with semantic understanding) after determining that a user message represents real, actionable work.

## WHEN to use this skill

Only call this skill when you determine a user message represents **actionable work**. Use your judgment as an LLM to classify intent.

**DO create a Request for:**
- "Build a login page with OAuth2" (code_change, L2)
- "Fix the broken test in auth.service.test.ts" (debugging, L1)
- "Deploy the staging environment" (deployment, L1)
- "Create a QA team with 3 members" (team_management, L2)
- "What endpoints does the auth service expose?" (query, L1)
- "Plan the migration to PostgreSQL" (planning, L2)

**DO NOT create a Request for:**
- "Hello" / "Hi team" (greeting)
- "Thanks!" / "Got it" / "OK" (acknowledgment)
- "How are you?" (small talk)
- "." / "k" / "yes" (filler)
- "Sounds good, let's proceed" (confirmation of prior work -- no new work)

## Intent Levels

Use these to classify the complexity of the request:

| Level | Meaning | Example |
|-------|---------|---------|
| L0 | Not actionable -- should NOT call this skill | "Thanks!", "Hello" |
| L1 | Simple, single-step task | "Fix the typo in README.md" |
| L2 | Multi-step, needs coordination or decomposition | "Build a new auth system with OAuth2 and tests" |
| L3 | Large project, should trigger Mission creation | "Rewrite the entire backend in Go with full test coverage" |

## Intent Categories

| Category | When to use |
|----------|-------------|
| communication | Sending messages, notifications, status updates |
| query | Questions, lookups, information retrieval |
| code_change | Writing, modifying, or refactoring code |
| planning | Architecture decisions, roadmap work, design |
| debugging | Bug fixes, investigation, troubleshooting |
| deployment | Deploy, release, environment management |
| team_management | Creating teams, adding members, role changes |
| other | Anything that does not fit the above |

## Parameters

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--title` | Yes | -- | Concise title summarizing the request |
| `--description` | Yes | -- | Full description of what the user asked for |
| `--intent-level` | Yes | -- | L0, L1, L2, or L3 |
| `--intent-category` | Yes | -- | communication, query, code_change, planning, debugging, deployment, team_management, other |
| `--priority` | No | normal | low, normal, high, urgent |
| `--source-message-id` | No | -- | Original message ID (for dedup) |
| `--needs-mission` | No | false | Whether this L3 request should trigger Mission creation |

## Examples -- CLI Flags (preferred)

```bash
# Simple bug fix
bash execute.sh --title "Fix auth test failure" \
  --description "The test in auth.service.test.ts is failing due to a missing mock" \
  --intent-level L1 --intent-category debugging \
  --source-message-id "msg_abc123"

# Complex multi-step request
bash execute.sh --title "Build OAuth2 authentication system" \
  --description "Create a complete OAuth2 auth system with Google and GitHub providers, including tests and documentation" \
  --intent-level L2 --intent-category code_change \
  --priority high --source-message-id "msg_def456"

# Large project needing Mission
bash execute.sh --title "Rewrite backend in Go" \
  --description "Full backend rewrite from Node.js to Go with all existing functionality preserved" \
  --intent-level L3 --intent-category code_change \
  --priority high --needs-mission true --source-message-id "msg_ghi789"
```

## Examples -- Legacy JSON (backward compatible)

```bash
bash execute.sh '{"title":"Fix auth test","description":"Fix failing test","intentLevel":"L1","intentCategory":"debugging"}'
```

## Output

JSON response with the created Request object including:
- `id` -- Unique Request ID
- `title` -- The title provided
- `status` -- "open" (initial status)
- `intentLevel` -- The classified intent level
- `intentCategory` -- The classified intent category

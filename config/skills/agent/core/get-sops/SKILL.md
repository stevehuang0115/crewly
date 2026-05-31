---
name: Get SOPs
description: Query standard operating procedures relevant to your current context or task.
version: 1.0.0
category: system
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
  - sales
  - support
triggers:
  - get sops
  - standard procedures
  - how to
  - best practices
tags:
  - system
  - sops
  - procedures
  - guidelines
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get SOPs

Query standard operating procedures (SOPs) relevant to your current context or task. SOPs contain team-defined guidelines, workflows, and best practices.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `context` | Yes | Description of what you need SOPs for (e.g., `"deploying to production"`) |
| `category` | No | Filter by SOP category (e.g., `"deployment"`, `"testing"`, `"code-review"`) |
| `role` | No | Filter by role relevance (e.g., `"developer"`, `"qa"`) |
| `sessionName` | No | Your session name. Lets the skill resolve your team and ALSO return your team's own installed/custom SOPs (the ones authored via `update-sop` / the wiki). |
| `teamId` | No | Explicit team id (skips the sessionName lookup). |

The result includes both the global SOPs and — when your team is resolved — a **Team SOPs** section from your team's library (`~/.crewly/teams/<id>/sops/`), so SOPs your team authored are actually visible here.

## Example

```bash
bash config/skills/agent/core/get-sops/execute.sh '{"context":"publishing an XHS post","category":"marketing","sessionName":"crewly-marketing-ella"}'
```

## Output

JSON with matching SOPs including their titles, content, and applicability metadata, plus a Team SOPs section when a team is resolved.

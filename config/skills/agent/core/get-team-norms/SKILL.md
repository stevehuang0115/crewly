---
name: Get Team Norms
description: Read your team's norms (operating agreements — canDelegate, escalation, rules of engagement) relevant to the current moment.
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
  - team-leader
  - sales
  - support
triggers:
  - get team norms
  - team norms
  - rules of engagement
  - can i delegate
  - escalation policy
tags:
  - system
  - norms
  - governance
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Team Norms

Read your **team norms** — the team's own operating agreement: who may delegate
to whom (`canDelegate`), role conventions, escalation paths, decision rights,
and rules of engagement. Norms are team-specific and authored by the team
(by the owner in the wiki, or proposed by agents via `update-team-norm`).

Norms differ from SOPs: a **SOP** is a reusable procedure ("how to do task X");
a **norm** is "how THIS team operates together." Consult norms before acting on
anything governance-related — delegating, escalating, deciding scope.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `trigger` | No | Filter to norms relevant to a moment (e.g. `"before_commit"`, `"delegation"`). Matched against the norm's `trigger:` list as whole tokens, case-insensitively — `"lead"` does NOT match a norm tagged `inbound_lead`. Pass several comma-separated to mean "any of these". Omit to read all. |
| `teamId` | No | Team to read. Defaults to the team resolved from your `sessionName`. |
| `sessionName` | No | Your session name, used to resolve the team when `teamId` is omitted. |

## Example

```bash
bash config/skills/agent/core/get-team-norms/execute.sh '{"trigger":"before_delegate"}'
```

## Output

JSON `{ success, count, data: [{ normId, title, trigger, content, updatedBy, updatedAt }] }`.
Returns an empty list if the team has no norms yet.

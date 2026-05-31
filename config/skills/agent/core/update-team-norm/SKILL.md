---
name: Update Team Norm
description: Propose or update a team norm (an operating agreement — canDelegate, escalation, rules of engagement) for your team.
version: 1.0.0
category: system
skillType: claude-skill
assignableRoles:
  - team-leader
  - tpm
  - product-manager
  - architect
  - generalist
  - developer
  - qa
triggers:
  - update team norm
  - propose a norm
  - set a team rule
  - we should always
  - going forward the team should
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

# Update Team Norm

Create or update a **team norm** — a durable operating agreement for your team
(who may delegate to whom, escalation paths, decision rights, rules of
engagement, recurring conventions). Use this when a lasting team-wide rule
emerges that future work should follow — not for one-off task notes (use the
wiki/memory for those) and not for reusable procedures (those are SOPs).

Norms you write land in the team's norm store and surface in the wiki under the
team's **Team Norms** folder, where the owner can review and edit them. Treat
this as *proposing* a norm: keep it concise, state the rule and when it applies.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `normId` | Yes | Stable kebab-case id / filename, e.g. `"code-commit"`, `"delegation"`. |
| `content` | Yes | The norm body (markdown). State the rule and its rationale. |
| `title` | No | Human title, e.g. `"Code Commit Norm"`. |
| `trigger` | No | When this norm applies, e.g. `"before_commit"`, `"before_delegate"`. |
| `append` | No | `"true"` to append to an existing norm instead of overwriting. |
| `teamId` | No | Team to write to. Defaults to the team resolved from `sessionName`. |
| `sessionName` | No | Your session name, used to resolve the team when `teamId` is omitted. |
| `updatedBy` | No | Who authored the change (your agent/session name). |

## Example

```bash
bash config/skills/agent/core/update-team-norm/execute.sh '{"normId":"delegation","title":"Delegation","trigger":"before_delegate","content":"Leads may delegate to their own team only; cross-team work goes through the orchestrator."}'
```

## Output

JSON `{ success, action: "created" | "updated", normId, path }`.

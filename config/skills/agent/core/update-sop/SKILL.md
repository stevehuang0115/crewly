---
name: Update SOP
description: Author or update a custom SOP (a reusable procedure / playbook) for your team.
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
  - qa-engineer
  - backend-developer
  - frontend-developer
  - fullstack-dev
triggers:
  - update sop
  - write a sop
  - document the procedure
  - create a playbook
  - standardize how we
tags:
  - system
  - sops
  - procedures
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Update SOP

Create or update a **custom SOP** for your team — a reusable procedure /
playbook for *how to do a class of work* (e.g. "publishing an XHS post",
"running a release"). The SOP is written into the team's own SOP store
(`~/.crewly/teams/<id>/sops/`) and surfaces in the wiki under the team's
**SOPs** folder, alongside SOPs installed from the catalog. The owner can edit
it in the wiki UI.

Use this for durable, repeatable procedures — not one-off task notes (use the
wiki/memory) and not team governance rules (those are **team norms** — use
`update-team-norm`). Prefer installing an existing catalog SOP when one fits;
author a custom SOP only when the team needs something the catalog lacks.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sopId` | Yes | Stable kebab-case id / filename, e.g. `"xhs-posting"`. |
| `content` | Yes | The SOP body (markdown). The steps/procedure. |
| `title` | No | Human title, e.g. `"XHS Posting Checklist"`. Required when creating. |
| `category` | No | Optional sub-folder, e.g. `"common"`, `"marketing"`. |
| `append` | No | `"true"` to append to an existing SOP instead of overwriting. |
| `teamId` | No | Team to write to. Defaults to the team resolved from `sessionName`. |
| `sessionName` | No | Your session name, used to resolve the team when `teamId` is omitted. |
| `updatedBy` | No | Who authored the change (your agent/session name). |

## Example

```bash
bash config/skills/agent/core/update-sop/execute.sh '{"sopId":"xhs-posting","title":"XHS Posting Checklist","category":"marketing","content":"1. Draft hook.\n2. Add 3-5 tags.\n3. Post 7-9pm."}'
```

## Output

JSON `{ success, action: "created" | "updated", sopId, title, category, path, relativePath }`.

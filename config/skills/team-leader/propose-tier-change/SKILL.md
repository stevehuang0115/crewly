---
name: Propose Tier Change (TL)
description: "Propose moving a member to another model tier (strong / mid / weak) or a task routing rule, then send all proposals to the owner as one card. Only while the team's 'Optimize usage' is on. Nothing changes until the owner says yes."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - propose tier change
  - model tier review
  - optimize usage
tags:
  - agent
  - management
  - model
  - cost
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Propose Tier Change (TL Version)

Members run on model tiers: **strong** (hard reasoning, design, reviewing others), **mid** (normal implementation and writing), **weak** (routine work: polling, checks, formatting, sorting, first-pass triage, summaries). Each tier maps to a model per runtime (Claude Code: opus / sonnet / haiku).

While the team's **Optimize usage** setting is on, you get a usage review every week (turns, context, output, estimated cost and work handled per member). Propose what should change, then submit. The owner gets **one card** with all proposals and taps Apply or Keep as is. You are told the answer.

## Usage

```bash
# 1. One call per member that should move
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --member "Ella" --tier weak --reason "only polls the inbox and sorts tickets; nothing was sent back"

# 2. Routing rules for incoming work (optional)
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --routing "polling / formatting / sorting -> Ella"

# 3. Send everything to the owner (one card). With nothing proposed, this just closes the review.
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --submit
```

`--clear` drops the draft. Proposing the same member again replaces its earlier proposal.

## Rules

- Never change a tier or model any other way; only the owner's Apply does it.
- Do not lower a member whose work was often sent back. You stay at mid or above.
- A member with a fixed model loses it when the owner applies its tier (the card says so).
- A draft you do not submit is sent to the owner automatically after two hours.
- After a member moves down, Crewly watches its next work items; if they are sent back clearly more often, the owner is asked whether to move it back.

## Output

`{"success":true,"data":{"added":"change","change":"Ella: mid -> weak","draft":{...}}}` / `{"success":true,"data":{"submitted":true,"decisionId":"D-12",...}}`

## Related Skills

- `start-agent` / `stop-agent` — restart an idle member so an approved tier applies now
- `delegate-task` — route work by tier

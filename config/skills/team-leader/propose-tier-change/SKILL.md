---
name: Propose Tier Change (TL)
description: "Propose moving a member to another model tier (strong / mid / weak) or a task routing rule, then submit them all at once. Only while the team's 'Optimize usage' is on. Approve mode: one owner card, nothing changes until the owner says yes. Auto mode: the changes apply at once and the owner gets a notice with Undo."
version: 1.1.0
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

While the team's **Optimize usage** setting is on, you get a usage review every week (turns, context, output, estimated cost and work handled per member). Propose what should change, then submit. What submit does depends on the team's change mode, which the owner sets (your prompt and the review say which one is on):

- **Approve** (default): the owner gets **one card** with all proposals and taps Apply or Keep as is. You are told the answer.
- **Auto** ("lead decides, tells me"): the changes apply **at once**, and the owner gets one notice listing them with **Undo**. You are told if the owner undoes them.

Either way, after a change applies, an idle member whose model changed is restarted on its new model; a busy member picks it up at its next start.

## Usage

```bash
# 1. One call per member that should move
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --member "Ella" --tier weak --reason "only polls the inbox and sorts tickets; nothing was sent back"

# 2. Routing rules for incoming work (optional)
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --routing "polling / formatting / sorting -> Ella"

# 3. Submit: one card to the owner (approve mode), or apply now + one notice (auto mode).
#    With nothing proposed, this just closes the review.
bash {{TL_SKILLS_PATH}}/propose-tier-change/execute.sh --submit
```

`--clear` drops the draft. Proposing the same member again replaces its earlier proposal.

## Rules

- Never change a tier or model any other way; only submit (and, in approve mode, the owner's Apply) does it.
- Do not lower a member whose work was often sent back. You stay at mid or above.
- A member with a fixed model loses it when its tier applies (the card or notice says so).
- A draft you do not submit is submitted automatically after two hours.
- After a member moves down, Crewly watches its next work items; if they are sent back clearly more often, the owner is asked whether to move it back (approve mode), or it is moved back at once and the owner told (auto mode).

## Output

`{"success":true,"data":{"added":"change","change":"Ella: mid -> weak","draft":{...}}}` / approve: `{"success":true,"data":{"submitted":true,"decisionId":"D-12",...}}` / auto: `{"success":true,"data":{"submitted":true,"applied":true,"noticeId":"D-12",...}}`

## Related Skills

- `start-agent` / `stop-agent` — not needed for tier changes: idle members are restarted automatically
- `delegate-task` — route work by tier

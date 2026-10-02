---
name: Set Team Lead
description: "Make a member the lead of its team (who triages, delegates and reviews). Works on any team, no hierarchical mode needed."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - set team lead
  - make lead
  - team lead
  - 负责人
tags:
  - team
  - management
  - lead
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Set Team Lead

Make a member the lead of its team. Use it when the owner says who should lead
a team, e.g. "让 Owen 当 CE 的负责人" / "make Owen the lead of CE".

Who leads a team is one rule everywhere in Crewly: the team's explicit leads
(what this skill sets), otherwise its `team-leader` / `tech-lead` members. The
lead drives the ticket autopilot, gets team-channel messages nobody @'d, and
gets the team-lead prompt on its next wake.

## Usage

```bash
bash config/skills/orchestrator/set-team-lead/execute.sh --team CE --member Owen
# keep the current lead(s) and add one more
bash config/skills/orchestrator/set-team-lead/execute.sh --team CE --member Vera --add
# JSON form
bash config/skills/orchestrator/set-team-lead/execute.sh '{"team":"CE","member":"Owen"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--team` / `team` | Yes | Team name or id |
| `--member` / `member` | Yes | Member name, session name or id |
| `--add` / `mode: "add"` | No | Add a lead instead of replacing the current one (default `set`) |

## Output

JSON with `teamName`, `lead`, `leads` (after) and `previous` (before). Tell
the owner in one line who leads the team now. Only the owner and the
orchestrator may change leads; an agent calling this gets 403.

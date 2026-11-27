---
name: Create Channel
description: "Create a Slack channel and put named agents in it — agents of any team, on this machine or another one, with or without their own Slack app — or add agents to an existing channel."
version: 1.1.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - create channel
  - make a channel
  - add to channel
  - 创建频道
  - 拉个群
tags:
  - slack
  - channel
  - cross-machine
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Create Channel

The owner asks (often from the phone): "make a channel with Owen from the CE team and the Lead of the growth team". Do it with this skill; never queue a work item for it.

## Usage

```bash
bash config/skills/orchestrator/create-channel/execute.sh --name ce-growth --members "Owen,Growth Team Lead" --purpose "CE x growth sync"
bash config/skills/orchestrator/create-channel/execute.sh --add ce-growth --members "Mia"
bash config/skills/orchestrator/create-channel/execute.sh --rename ce-posts --to ce-posts
```

`--members` takes display names, session names or `<team name> Lead`, comma separated. Agents on this machine are added directly; agents on other machines are resolved through the Crewly Cloud colleague directory and asked to join through Cloud (they appear in the channel shortly after). Agents without their own Slack app post under their own name through the Crewly app, so they need no setup.

A new or renamed channel gets this machine's Slack channel prefix (if one is set), so use the name the output reports. Rename a channel only when the owner asks; renaming it to its own name adds a missing prefix.

## Output

`ADDED`, `ASKED` (another machine, joins shortly), `FAILED`, `AMBIGUOUS` (several matches — ask the owner which) and `NOT FOUND` lines. If any line is FAILED / AMBIGUOUS / NOT FOUND, tell the owner plainly what was not added and why. Do not wait silently.

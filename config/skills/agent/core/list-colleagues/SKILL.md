---
name: List Colleagues
description: Who you can @ in Slack — every Crewly agent of this account (on any machine) with its team, machine and Slack mention, plus everyone actually in a given channel, including agents of other Crewly accounts and other bots.
version: 1.0.0
category: communication
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
  - sales
  - support
  - researcher
  - devops
  - operations
triggers:
  - list colleagues
  - who can i mention
  - who is in this channel
  - 同事列表
tags:
  - slack
  - directory
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# List Colleagues

The directory behind `@Name` in `reply-channel`. Use it before handing
work to someone you have not talked to yet, or when a channel has people
you do not recognise.

```bash
bash execute.sh                    # every agent of the account, all machines
bash execute.sh --channel C0ABC12  # + everyone actually in that channel
```

Output: `{ "channel": "C0ABC12"|null, "colleagues": [ { "name", "mention",
"team", "machine", "source", "kind", "inChannel", "agentSession" } ] }`.

- `mention` is what to write in a reply to reach them (`@Name` in
  `reply-channel` is turned into it automatically).
- `machine` = `this machine` for agents running here, otherwise the device
  name of the Crewly instance that runs them.
- `kind` = `agent` (a Crewly agent of this account), `bot` (a bot in the
  channel from another Crewly account or another system), `human`.

Only available while Slack runs through Crewly Cloud.

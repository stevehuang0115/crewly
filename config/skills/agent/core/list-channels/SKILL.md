---
name: List Channels
description: The Crewly channels you are in — rooms shared with agents of other teams, each matched to a Slack channel — with their members and Slack link. Use it to find where to post.
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
  - list channels
  - which channels am i in
  - where should i post
  - 频道列表
tags:
  - channels
  - chat
  - slack
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# List Channels

A Crewly channel is a room whose members are agents from any team (a daily
brief room with a researcher, an engineer and the owner, say). When Slack is
connected each one is a Slack channel with the same name and members.

```bash
bash execute.sh         # the channels you are a member of
bash execute.sh --all   # every channel
```

Output: `{ "data": { "channels": [ { "id", "name", "purpose", "origin",
"slack": { "channelId", "channelName" } | null, "members": [ { "sessionName",
"name", "teamName" } ] } ] } }`.

- Post in a channel: `reply-channel --channel '#<name>' --content "..."` (or
  `--channel <id>`). Everyone in it sees it, in Crewly and in Slack.
- `id` never changes (renames keep it); prefer it when you store a reference.
- Only the owner creates channels and changes their members.

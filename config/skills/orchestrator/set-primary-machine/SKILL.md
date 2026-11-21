---
name: Set Primary Machine
description: Choose which of the owner's machines is the account's primary (the one that receives the Crewly DM and messages in channels no team owns), or show which one it is. Use only when the owner asks to change it.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - set primary machine
  - make this the main machine
  - change the primary machine
  - which machine is primary
  - 主机
tags:
  - machines
  - account
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Set Primary Machine

One Crewly account can run on several machines. Messages to the account's Crewly DM, and messages in Slack channels that no team owns, go to one of them: the **primary**. It is an account setting kept by Crewly Cloud, so it can be changed from any machine and takes effect for all of them at once. When the owner has not chosen one, Cloud picks the machine with the most teams and keeps it.

## Steps

1. Show the machines: `bash {{ORCHESTRATOR_SKILLS_PATH}}/set-primary-machine/execute.sh '{"action":"show"}'`. Each has `deviceName`, `primary`, `live`, and on the primary `primarySetBy` (`owner` = chosen, `default` = Cloud picked it).
2. If the owner named a machine, set it: `... '{"action":"set","machine":"mac-mini"}'` (the name as shown, with or without `.lan`).
3. To go back to Cloud's default choice: `... '{"action":"clear"}'`.
4. Tell the owner in one line which machine is the primary now.

Change it only on the owner's word. A machine that is offline can still be chosen; while it is offline its messages go to another machine, and return to it when it is back.

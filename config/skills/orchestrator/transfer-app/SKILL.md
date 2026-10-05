---
name: Transfer App
description: Hand a Crewly App (apps.crewlyai.com/<appId>) to another agent or team, so the new team can publish new versions. Use when the owner moves work between teams.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - transfer app
  - move app to team
  - hand over app
  - new team takes the app
tags:
  - apps
  - transfer
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Transfer App

Crewly Apps are team-scoped: only the publisher and its teammates can publish, roll back, list versions or use the data of an app. When the owner moves a project from one team to another, the app has to move with it, otherwise the new team gets `not_your_app`.

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/transfer-app/execute.sh '{"appId":"vm4p556kuj","toSession":"edu-game-milo-13e8d3ca"}'
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `appId` | Yes | The 10-character app id (see `publish-app --list`) |
| `toSession` | Yes | Session of the agent that takes over (a member of an active team on this machine; pick the new team's lead or the member who builds the app) |

What happens: Cloud's publisher and the local registry switch to `toSession`; app comments, change wakes and thumbnails follow the new publisher; the old team loses manage rights; both the old and the new publisher get a short note. The new publisher then publishes with `publish-app --app <appId> --dir <its directory>`.

Do this when the owner says work or a project moved between teams. Do not transfer an app without that; transfers are visible to the owner in the portal (publisher name).

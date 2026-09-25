---
name: Install Skill
description: Install a skill (and the system tools, models and Python packages it declares) as a background job. Returns a job id at once; you get a [SKILL INSTALLED] / [SKILL INSTALL FAILED] message when it ends. Official skills install without asking; third-party ones need the owner's yes in chat first.
version: 1.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - install skill
  - set up skill
  - needsSetup
  - missing dependency
tags:
  - skills
  - marketplace
  - install
  - setup
  - auto-install
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Install Skill

Use after `find-skill`, or when a skill answered `"needsSetup": true, "skill": "<id>"`.

```bash
bash {{AGENT_SKILLS_PATH}}/core/install-skill/execute.sh --id transcribe-audio --resume "transcribe the voice message Steve sent in #general"
```

It returns immediately:

```json
{"success":true,"jobId":"3f9c1a2b","skillId":"transcribe-audio","state":"running","official":true,
 "estimatedMinutes":6,"willNotify":["crewly-dev-1"],
 "next":"Installing transcribe-audio in the background (about 6 min). Tell the user now…"}
```

or `{"success":true,"state":"already-ready","executePath":"…"}` — use the skill now.

## The flow

1. Tell the user in **one line** that you are installing it and roughly how long it
   takes ("I can't read audio yet — installing the transcription skill, about 6 min.").
2. Run `install-skill`. Pass `--resume` with what you were doing; it comes back to you.
3. When `[SKILL INSTALLED] …` arrives, tell the user it's ready and **do the original
   task right away**. On `[SKILL INSTALL FAILED] …`, tell the user plainly what is
   missing and the fix the message gives (e.g. a command the owner must run).

Never answer "X is not installed" and stop.

## Trust

- **Official** (bundled with Crewly, or published by the Crewly Team in the official
  registry): installs without asking, including the system dependencies it declares.
- **Third-party**: refused with `reason: owner_approval_required`. Ask the owner in chat
  (say what it is and who publishes it). Only after they say yes:
  `install-skill --id <id> --approved-by-owner --owner-said "<their words>"`.
  The backend checks the owner's recent chat for that yes; claiming it without one fails
  (`owner_approval_not_found`).

Progress: `GET /api/skill-setup/jobs/<jobId>`. Setup log: `~/.crewly/logs/skill-setup/<id>.log`.

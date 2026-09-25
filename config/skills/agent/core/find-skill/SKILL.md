---
name: Find Skill
description: Find a skill that gives you a capability you lack (a file type you cannot read, a missing tool). Searches bundled Crewly skills, installed skills and the marketplace; says which are official, installed and ready. Run it BEFORE telling the user you cannot do something.
version: 1.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - find skill
  - missing capability
  - cannot read this file
  - not installed
  - need a tool
tags:
  - skills
  - marketplace
  - install
  - capability
  - auto-install
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Find Skill

Before you tell the user "I can't do that" or "X is not installed", look for a
skill that does it.

```bash
bash {{AGENT_SKILLS_PATH}}/core/find-skill/execute.sh --query "transcribe a voice message"
bash {{AGENT_SKILLS_PATH}}/core/find-skill/execute.sh --query "read a pdf" --limit 3
```

## Output

```json
{"success":true,"query":"transcribe a voice message",
 "next":"transcribe-audio is an official skill (bundled with Crewly) that is not ready yet. Tell the user in one line that you are installing it (about 6 min), then run install-skill --id transcribe-audio and continue when the completion message arrives.",
 "candidates":[{"id":"transcribe-audio","official":true,"officialReason":"bundled with Crewly",
   "installed":true,"ready":false,"setup":{"declared":true,"estimatedMinutes":6,"satisfied":false,"missing":["whisper-cli","whisper-model"]},
   "executePath":"/…/transcribe-audio/execute.sh","source":"bundled"}]}
```

Follow `next`:

- **ready** — use the skill now (`executePath`).
- **official, not ready** — tell the user in one line that you are installing it
  and roughly how long it takes, then `install-skill --id <id>`.
- **third-party** (`official:false`) — ask the owner in chat first; install only
  after they say yes (`install-skill --id <id> --approved-by-owner`).
- **no candidates** — say plainly what you cannot do.

Official = bundled with Crewly, or listed in the official registry by the Crewly Team.

---
name: Restart Crewly
description: Gracefully restart the Crewly backend server. Sessions are saved and auto-resumed on restart.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - restart crewly
  - restart backend
  - restart server
  - reboot server
tags:
  - system
  - management
  - restart
  - server
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Restart Crewly

Gracefully restart the Crewly backend server. All PTY sessions are saved before shutdown and will be auto-resumed on restart (if the auto-resume setting is enabled).

## Usage

```bash
bash config/skills/orchestrator/restart-crewly/execute.sh
```

## Parameters

None required.

## Output

JSON confirming the restart was initiated and how many sessions were saved.

## How It Works

1. The backend saves all PTY session state to disk
2. The backend exits with a special restart exit code (120)
3. The CLI parent process detects this code and automatically respawns the backend
4. The new backend instance restores saved sessions and resumes normal operation

## Notes

- The restart is fully automatic when launched via `crewly start` — no external process manager needed
- In development mode (`npm run dev`), the tsx file watcher handles restarts
- Agents will auto-resume their previous sessions on restart if the "Auto-Resume on Restart" setting is enabled

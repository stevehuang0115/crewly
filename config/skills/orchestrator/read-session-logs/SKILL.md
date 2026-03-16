---
name: Read Session Logs
description: Read persistent terminal log file for a session (ANSI-stripped, includes pre-restart output).
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - session logs
  - agent logs file
  - terminal history
tags:
  - logs
  - monitoring
  - session
  - terminal
  - history
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Read Session Logs

Read the persistent log file for a PTY session. Unlike `get-agent-logs` (which reads the live terminal buffer), this reads the ANSI-stripped log file at `~/.crewly/logs/sessions/{sessionName}.log`.

Key difference: This log file **survives session restarts** and includes output from before the last restart, separated by `--- SESSION RESTARTED at ... ---` markers.

## Parameters

| Parameter     | Type   | Default | Description                            |
|---------------|--------|---------|----------------------------------------|
| `sessionName` | string | (required) | PTY session name (e.g., `crewly-orc`) |
| `lines`       | number | 100     | Number of recent lines to return        |

## Usage

```bash
# Read last 200 lines of orchestrator session log
bash config/skills/orchestrator/read-session-logs/execute.sh '{"sessionName":"crewly-orc","lines":200}'

# Read agent session log
bash config/skills/orchestrator/read-session-logs/execute.sh '{"sessionName":"crewly_team1_dev1","lines":100}'
```

## Response

Returns a JSON object with `lines` (array of strings), `sessionName`, `count`, and `totalLines`.

## When to Use

- To investigate what happened before an agent crashed/restarted
- To find error output that has scrolled past the live terminal buffer
- During self-evolution triage when the live buffer isn't sufficient
- To correlate session activity with server log errors

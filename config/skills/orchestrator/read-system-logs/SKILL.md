---
name: Read System Logs
description: Read recent Crewly server log entries from the persistent log file.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - system logs
  - server logs
  - error logs
tags:
  - logs
  - monitoring
  - system
  - errors
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Read System Logs

Read recent entries from the Crewly server log file (`~/.crewly/logs/crewly-YYYY-MM-DD.log`).

## Parameters

| Parameter | Type   | Default | Description                                       |
|-----------|--------|---------|---------------------------------------------------|
| `lines`   | number | 100     | Number of recent log lines to return               |
| `level`   | string | (all)   | Filter by log level: `error`, `warn`, `info`, `debug` |

## Usage

```bash
# Get last 100 log entries (all levels)
bash config/skills/orchestrator/read-system-logs/execute.sh '{"lines":100}'

# Get only error-level entries
bash config/skills/orchestrator/read-system-logs/execute.sh '{"lines":200,"level":"error"}'
```

## Response

Returns a JSON array of log entries, each with `level`, `message`, `timestamp`, and optional metadata fields.

## When to Use

- After detecting agent misbehavior to check for server-side errors
- During self-evolution triage to gather evidence
- When debugging system issues (crashes, timeouts, delivery failures)

---
name: Team Health Scan
description: On-demand snapshot of the Team-Health-Watchdog (THW) verdicts. Returns per-team health (🟢/🟡/🔴/🚨/🟪) plus the gates that fired, so an operator can investigate before the next 60s sweep.
version: 1.0.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - team health
  - health scan
  - is anything stuck
  - team-health-scan
tags:
  - team-health
  - watchdog
  - monitoring
  - liveness
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Team Health Scan

Returns the current per-team health verdicts from the Team-Health-Watchdog (THW), the system-level liveness aggregator (Layer 4 of the four-layer liveness stack).

## When to use

- Before EOD: "is anything stuck I should know about?"
- After a Slack alert: "you flagged Marketing 🔴; show me the gates."
- During shadow-mode review: inspect candidate detections without waiting for the next sweep.

## Verdict tiers

| Code | Display | Meaning |
|---|---|---|
| `healthy` | 🟢 | No concerning signals |
| `stalling` | 🟡 | Soft concern; observation-only |
| `stuck` | 🔴 | Sharp concern; action expected |
| `cascade` | 🚨 | Multi-team correlated failure |
| `stale` | 🟪 | Stale-trigger refire — assignee should confirm/cancel |

## Usage

```bash
# All teams:
bash execute.sh '{}'

# One team:
bash execute.sh '{"teamId":"marketing"}'

# Force a fresh sweep (bypass the 60s cache):
bash execute.sh '{"force":true}'
```

## Response shape

```jsonc
{
  "success": true,
  "data": {
    "verdicts": [
      {
        "teamId": "marketing",
        "verdict": "stuck",
        "gates": {
          "team_idle": true,
          "team_pending": true,
          "team_silent": true,
          "cascade_with_siblings": false
        },
        "pendingWorkItemIds": ["wi-1", "wi-2"],
        "idleAgentSessions": ["ella", "grace"],
        "lostDispatchWorkItemIds": [],
        "rationale": "Team has 2 pending WorkItem(s); 2 member(s) idle and no trigger has fired recently.",
        "detectedAt": "2026-04-25T19:30:00.000Z"
      }
    ],
    "lastSweep": {
      "sweptAt": "2026-04-25T19:30:00.000Z",
      "durationMs": 7,
      "shadowMode": true
    },
    "lastSweepAgeMs": 1234,
    "degraded": false
  }
}
```

`degraded: true` indicates the watchdog itself has stopped sweeping (last sweep > 3× sweep interval). Investigate the backend `/api/health` endpoint.

## Layer-4 invariant

This skill is **read-only**. THW does NOT change agent status, claims, or work items — it only emits alerts. To act on a verdict, use the relevant skill (`start-agent` to restart a member, `assign-task` to reassign, etc.).

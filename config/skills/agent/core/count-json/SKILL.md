---
name: Count JSON
description: Run a command that prints JSON and count the entries matching a field=value filter. Built for skill_output Key Results (e.g. "tickets in review") so a KR can be measured from any board or API that speaks JSON.
version: 1.0.0
category: measurement
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - devops
  - operations
  - ops
triggers:
  - count json
  - measure kr
tags:
  - okr
  - measurement
  - json
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Count JSON

Runs a command, reads the JSON it prints (an array, or an object holding an
array under `items` / `tickets` / `data`), applies an optional `field=value`
filter, and prints `{"count": N, "total": M, "filter": "..."}`.

Made for `measurementSource: "skill_output"` Key Results:

```json
{ "measurementConfig": { "skill": "count-json",
                         "args": { "command": "cd /opt/app/web && make tickets TICKET_ARGS=--json",
                                   "field": "status", "value": "review" },
                         "jsonPath": ".count" } }
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `command` | yes | Shell command whose stdout is JSON (or a `file` path instead) |
| `file` | no | Read JSON from this file instead of running a command |
| `field` | no | Top-level field to filter on |
| `value` | no | Value that `field` must equal (string compare) |
| `arrayPath` | no | jq path to the array when it is nested (default: auto-detect) |

## Output

```json
{"count": 6, "total": 21, "filter": "status=review"}
```

The command runs with a 50 s timeout; a non-JSON result exits 1 with an error
object on stderr.

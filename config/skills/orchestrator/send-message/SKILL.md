---
name: Send Message
description: "Readiness-aware message delivery to an agent's terminal session via /terminal/{session}/deliver. Distinct from agent/core/send-message which uses /terminal/{session}/write."
version: 1.2.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - send message
  - tell agent
  - message agent
  - deliver message
tags:
  - communication
  - agent
  - message
  - readiness-aware
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Message (orchestrator — readiness-aware delivery)

Delivers a text message to an agent's terminal session via the
**`POST /terminal/{session}/deliver`** endpoint.

## When to use this vs `agent/core/send-message`

| | `orchestrator/send-message` | `agent/core/send-message` |
|---|---|---|
| Endpoint | `POST /terminal/{id}/deliver` | `POST /terminal/{id}/write` |
| Readiness gate | Yes — waits up to 10 s for an idle agent; a busy one gets the message queued and the skill returns at once | Queues for a mid-turn Claude Code agent; otherwise writes immediately |
| Force override | Yes — `force: true` skips the readiness wait | n/a |
| Typical caller | Orchestrator dispatching new work to an agent that may currently be busy | Any agent that just wants to drop a line into another session's PTY |

Prefer this skill when the orchestrator needs the message to land **at**
the agent's prompt rather than mid-turn. Use `agent/core/send-message`
for fire-and-forget cross-agent comms.

## Never waits on a busy agent

The skill never keeps your turn waiting for the recipient. It waits at most
10 seconds for an idle agent. If the agent is still busy, the message goes on
that agent's queue and the skill returns immediately with
`"queued": true`, `"delivered": false`, its `position` in the queue (1 = next)
and a `note`. The message is delivered automatically when the agent is idle.
Do not resend it, do not poll for it, and do not wrap the call in a long
`timeout`: carry on with your turn. To check later whether it went out, look
at the agent's terminal or wait for its reply.

## Usage

```bash
# Default: deliver now if the agent is idle (≤10 s), otherwise queue it
bash config/skills/orchestrator/send-message/execute.sh \
  '{"sessionName":"agent-joe","message":"Please review the PR"}'

# Force: write immediately even if the agent is busy mid-turn
bash config/skills/orchestrator/send-message/execute.sh \
  '{"sessionName":"agent-joe","message":"URGENT: stop","force":true}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The target agent's PTY session name |
| `message` | Yes | The message text to deliver |
| `force` | No | When `true`, write directly to PTY without waiting for the agent prompt. Defaults to `false` (deliver when idle, queue when busy). |

## Output

- Delivered: `{"success":true,"verified":true}`.
- Queued (agent busy): `{"success":true,"queued":true,"delivered":false,"position":2,"queueSize":3,"note":"…"}`.
  With `"spendCapped": true` the agent has hit its daily token cap; the
  message waits until the cap resets or the owner boosts it.

## Paused teams

The owner can pause a team temporarily (specs/2026-10-04-team-pause.md). A
paused team is hidden from agents and takes no work: handing it work, or
messaging, starting or assigning a ticket to one of its members, fails with
`code: "team_paused"` and a message saying what to do instead — usually
`gh issue create -R <repo> --title "…" --body "…"` (the team's issue repo),
otherwise tell the orc. Do that; do not retry or route around the pause.

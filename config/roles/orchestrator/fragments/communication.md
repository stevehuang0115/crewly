# Orchestrator Communication Protocol

## CRITICAL: Notification Protocol — ALWAYS RESPOND TO THE USER

**The #1 rule: Every `[CHAT:...]` message MUST produce at least one `[NOTIFY]` response.** The user is waiting for your reply. If you do work (bash scripts, status checks, log reviews) without outputting a `[NOTIFY]`, the user sees nothing — it looks like you ignored them.

### The `[NOTIFY]` Marker (Chat UI)

The `[NOTIFY]...[/NOTIFY]` marker sends messages to the **Chat UI**. Use **header + body** format: routing headers go before the `---` separator, the message body goes after it.

**Format:**

```
[NOTIFY]
conversationId: conv-abc123
type: project_update
title: Project Update
---
## Your Markdown Content

Details here.
[/NOTIFY]
```

**Headers** (all optional, one per line before `---`):

- `conversationId` — copy from incoming `[CHAT:convId]` to route to Chat UI
- `type` — notification type (e.g. `task_completed`, `agent_error`, `project_update`, `daily_summary`, `alert`)
- `title` — header text for display
- `urgency` — `low`, `normal`, `high`, or `critical`

**Body** (required): Everything after the `---` line is the message content (raw markdown). No escaping needed — just write markdown naturally.

**Simple format** (no headers): If you only need to send a message with no routing headers, you can omit the headers and `---` entirely — the entire content becomes the message body.

### The `reply-slack` Skill (Slack)

For Slack messages, use the `reply-slack` bash skill instead of `[NOTIFY]` headers. This sends messages directly via the backend API, bypassing PTY terminal output and avoiding garbled formatting.

```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/reply-slack/execute.sh '{"channelId":"C0123","text":"Task completed!","threadTs":"170743.001"}'
```

### Dual Delivery (Chat + Slack)

When you need to reach both Chat UI and Slack (common for proactive updates), use **both** methods:

1. Output a `[NOTIFY]` with `conversationId` for the Chat UI
2. Run `reply-slack` skill for the Slack channel

### Response Timing Strategy

**For quick answers** (status checks, simple questions): Do the work, then respond with results.

**For multi-step work** (delegating tasks, investigating issues, anything taking >30 seconds):

1. **Respond IMMEDIATELY** with what you're about to do
2. Do the work (run bash scripts, checks, etc.)
3. **Respond AGAIN** with the results

### How to Respond to Chat Messages

When you receive `[CHAT:conv-abc123]` prefix, output a `[NOTIFY]` with the `conversationId` copied from the incoming message.

**CRITICAL: Check for Slack thread context!** If the message includes `[Thread context file: <path>]`, it came from Slack. You MUST:

1. Read the thread context file to get the `channel` and `thread` values from its YAML frontmatter
2. Output a `[NOTIFY]` with `conversationId` for the Chat UI (as usual)
3. **ALSO** call the `reply-slack` skill to send your response to Slack

**Every response to a Slack-originated message MUST include both a `[NOTIFY]` AND a `reply-slack` call.** If you only output `[NOTIFY]`, the user sees nothing in Slack.

### MANDATORY Response Protocol — NO SILENT WORK

**Every chat message MUST be answered using `[NOTIFY]` markers with a `conversationId` header.**

**CRITICAL ANTI-PATTERN TO AVOID:** Receiving a `[CHAT:...]` message, then running 3-5 bash scripts without ever outputting a `[NOTIFY]`. The user sees NOTHING during this time. **Always output a response to the user — even a brief one — before or between script calls.**

### Important Rules

1. **NEVER let a chat message go unanswered** — every `[CHAT:...]` MUST get a `[NOTIFY]`
2. **Always include the `conversationId`** from the incoming `[CHAT:conversationId]` in your `[NOTIFY]` headers
3. **Respond before AND after work** — don't make the user wait in silence while you run multiple scripts
4. **Use markdown in the body** — it renders nicely in the Chat UI
5. **Use `reply-slack` skill for Slack delivery** — do NOT put `channelId` in `[NOTIFY]` headers
6. **No JSON escaping needed** — write markdown naturally in the body after `---`

## Slack Communication

### Slack Guidelines

1. **Response Format**: Keep Slack messages concise and mobile-friendly
2. **Status Updates**: Proactively notify users of important events
3. **Command Recognition**: Users may send commands like "status", "tasks", "pause", "resume"

### Slack Response Format

- Short paragraphs (1-2 sentences)
- Bullet points for lists
- Emojis sparingly for status (✅ ❌ ⏳)
- Code blocks for technical output

### Thread-Aware Slack Notifications

When you receive messages from Slack, they include a `[Thread context file: <path>]` hint. When event notifications arrive with `[Slack thread files: <path>]`, read the file to get the originating thread's `channel` and `thread` from the YAML frontmatter.

**Always include `threadTs` and `channelId`** when calling `reply-slack` and you know the originating thread.

## Communication Channels

| Channel  | Use Case         | Response Style          |
| -------- | ---------------- | ----------------------- |
| Terminal | Development work | Detailed, technical     |
| Chat UI  | User interaction | Conversational, helpful |
| Slack    | Mobile updates   | Concise, scannable      |

Adapt your communication style based on the channel being used.

## Communication Protocol — Orc-Namespace Gate (MANDATORY)

> Spec provenance: 4-piece skill-mistake fix dispatch piece #2 (Sam→Quinn, post-PR #446 merge).

**The agent-side skills under `config/skills/agent/core/` exclude orchestrator from `assignableRoles` for a reason.** Reaching for them from this orchestrator session bypasses the orc-routing layer:

- agent-side `send-message` writes raw bytes to a peer's PTY via `/terminal/{session}/write` without readiness gating
- orc-side `send-message` uses `/terminal/{session}/deliver` with the readiness-aware two-step delivery pattern + retry

Always reach for `{{ORCHESTRATOR_SKILLS_PATH}}/<skill>/` first. Orc-namespaced equivalents you have:

| Need | Use orc-namespaced | NOT agent-side |
|---|---|---|
| Send a direct message to an agent | `{{ORCHESTRATOR_SKILLS_PATH}}/send-message/execute.sh` (readiness-aware, `/deliver`) | `{{AGENT_SKILLS_PATH}}/core/send-message/execute.sh` (raw `/write`) |
| Record success / failure / bug | `{{ORCHESTRATOR_SKILLS_PATH}}/record-success/`, `/record-failure/`, `/report-bug/` | `{{AGENT_SKILLS_PATH}}/core/report-status/` (workers→orc, not orc→self) |
| Multi-agent fan-out | `{{ORCHESTRATOR_SKILLS_PATH}}/broadcast/`, `/broadcast-to-org/` | n/a |
| Reply to user on the source channel | `{{ORCHESTRATOR_SKILLS_PATH}}/reply-chat/`, `/reply-slack/`, `/reply-gchat/`, `/reply-remote/` | n/a |
| Schedule recurring or one-off checks | `{{ORCHESTRATOR_SKILLS_PATH}}/schedule-check/`, `/create-cron/`, `/cancel-schedule/` | n/a |
| Cross-agent memory access | internal `recallFromAllAgents()` in `memory.service.ts:1047` (service-layer, not skill) | `{{AGENT_SKILLS_PATH}}/core/recall/` (excludes orchestrator from assignableRoles) |

**Negative pattern to suppress:** an orc agent reaching for `{{AGENT_SKILLS_PATH}}/core/send-message/` because it's "the obvious skill" — the result is messages written to peers' raw PTY buffers without readiness gating. The exact "ORC was using WRONG send-message skill" gotcha recorded in the project knowledge base on 2026-05-05.

**Bash invocation example (orc-namespaced send-message):**
```bash
bash {{ORCHESTRATOR_SKILLS_PATH}}/send-message/execute.sh '{"to":"<session>","message":"<msg>"}'
```

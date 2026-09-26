# Orchestrator reply routing

The orchestrator answers in the conversation it was asked in. Implemented by
`backend/src/services/orc/orc-reply-route.service.ts`.

## Turn origin

`AgentRegistrationService.sendMessageToAgent` calls
`OrcReplyRouteService.noteDelivery(session, message)` for every message it
delivers (in-process runtime and PTY). A message whose first token is a
`[CHAT:<id>]` / `[GCHAT:<id>]` header is user-originated. Both paths put that
header first:

| Path | Header | Origin |
|---|---|---|
| chat-v2 dispatcher (web chat, Slack agent-bot DMs, Slack team rooms) | `[CHAT:<channel>] <sender@name>` | chat-v2 channel |
| message queue (master-bot Slack bridge, legacy chat) | `[CHAT:<conv>:<fp>] … [SLACK:<ch>:<ts>]` | conversation (fingerprint stripped) + Slack channel/thread |

That message becomes the session's **turn origin**. System deliveries
(`[SYSTEM]…`, `[CREWLY-DISPATCH]`, reminders) do not change it, so a system
turn that follows a user turn still answers the user. Every inbound
conversation and Slack channel is also remembered with its time.

| Constant (`ORC_REPLY_ROUTE_CONSTANTS`) | Value | Meaning |
|---|---|---|
| `ORIGIN_TTL_MS` | 15 min | origin is "fresh" this long after the last user message |
| `RECENT_INBOUND_MS` | 30 min | a conversation written from within this window is one the orc is in |

## What counts as the reply

Only posts by the orchestrator: the `X-Agent-Session` header when present,
else the body (`senderType: 'orchestrator'` / orchestrator sender name, or
`senderSessionName` for Slack).

| Endpoint (skill) | Rule |
|---|---|
| `POST /api/chat/agent-response` (reply-chat, report-status) with no `conversationId` | the last turn origin (any age); previously `getCurrentConversation()`, which only lists system-owned channels and so never returns the owner's orchestrator DM |
| same, with a `conversationId` | kept if it is the origin, if a user wrote from it within `RECENT_INBOUND_MS`, if `crossPost: true`, or if there is no fresh origin; otherwise **re-routed to the origin** with a WARN log |
| `POST /api/slack/send` (reply-slack) to a Slack **DM** (`D…`) | same rule, against the origin's Slack channel (from the `[SLACK:]` marker, or the agent-bot DM the origin chat-v2 channel is linked to). Re-route target: the origin's Slack channel/thread if known, else the origin chat-v2 conversation (stored as the orchestrator's reply; the Slack DM bridge mirrors it under the right bot) |
| `POST /api/slack/send` to a Slack **channel** | never re-routed (team notifications, delegation) |
| `reply-channel` writes | not replies; untouched |

`--cross-post` on `reply-chat` / `reply-slack` sends `crossPost: true` for a
post the orc was asked to make somewhere else.

## Delivered format for Slack DMs

When a chat-v2 DM message came from a Slack DM (`metadata.source === 'slack'`,
`slackChannelId` `D…`), the reply hint names the target explicitly and says it
holds for follow-up progress, questions and `[BLOCKED]`/`[DONE]` reports:

```
回复本频道: 这条消息来自 Slack 私信 D0C381XPD3L。回复目标: conversationId="<channel>"——用 `reply-chat` skill …
```

## Incident: 2026-09-26 03:23–03:34 UTC

The owner talked to the orc in its bot DM `D0C381XPD3L` (chat-v2 `a721f48d`).
At 03:32:30 the reconciler redispatched three WorkItems; that system turn ran
03:32:44–03:33:51 and:

- 03:32:59 `report-status [BLOCKED]` with no conversation → `getCurrentConversation()` → `#think-tank` (`b79a6e4d`);
- 03:33:30 `reply-slack` to `D0AC7NF5N7L`, the owner's DM with the **master** bot (observability `agent.action`);
- 03:33:48 `reply-chat` → `b79a6e4d`, mirrored to Slack `#pro-think-tank`.

The owner never saw the question ("reply start Ella") in that summary.

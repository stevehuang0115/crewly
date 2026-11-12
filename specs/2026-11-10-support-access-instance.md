# Support access — the instance side (crewly#1558 slice 2)

Status: implemented (branch `feat/1558-support-api`). Slice 1 is the Cloud
side: grants in crewly-auth and the relay's grant check. Settings › Access (grant /
revoke UI) is a later slice; the `support-view-instance` skill is
`specs/2026-11-12-support-access-agent-read.md`.

Owner decisions (2026-11-10): private-sourced content is withheld unless the
instance owner turns on "include private content" for the grant; admin
actions are restart an agent and read non-secret settings, nothing else,
never secrets or connector tokens.

## Transport and trust

```
grantee B ──api_request──▶ relay ──(grant check, adds supportGrant)──▶ A's queue
                                                                        │
A's instance: cloud-sync poll ─▶ IncomingMessage.supportGrant ─▶ SupportRelayService
                                                                        │
                       api_response {id, status, body} ◀── to supportGrant.replyQueueId
```

- The relay adds `supportGrant` at the TOP level of the wrapper inside the
  relay `payload` string (`{type, data, encrypted, fromDeviceName,
  supportGrant}`) and strips that key from every sender payload, same-account
  ones included. Its presence means the relay vouched for it.
- `CloudSyncService.pollMessages` copies it to `IncomingMessage.supportGrant`
  after `parseSupportGrantEnvelope` (exact shape: `grantId`, `role` viewer |
  admin, boolean `includePrivate`, `granteeEmail`, `granteeAccountId`,
  `replyQueueId`; unknown fields dropped). A key with a bad shape becomes
  `null`; no key stays `undefined`. A `supportGrant` inside `data` is never
  read.
- `MobileApiRelayService` (owner REST passthrough) ignores any message whose
  `supportGrant` is not `undefined`. Its allowlist has no `/support/` path, so
  an owner call never reaches the support API either.
- `SupportRelayService` handles only `api_request` messages with the key.

## Checks, in order (`support-relay.service.ts`)

| Check | Outcome |
|---|---|
| envelope `null` (malformed) | dropped, audited, no answer |
| no `data.id` | dropped, audited |
| `support.allowGrantees` off (or settings unreadable) | 403 `support_disabled` |
| `encrypted: true` | 403 `support_encrypted_refused` |
| path not a clean `/support/<…>` (no `%`, `\`, `#`, whitespace, dot or empty segments; query allowed) | 403 `support_path_refused` |
| method not allowed for the role (viewer GET; admin GET, POST) | 403 `support_method_refused` |
| otherwise | `SupportApiService.handle(caller, request)` |

The caller is a frozen `SupportCaller` (`kind: 'support'` + envelope). The
answer goes to `replyQueueId` (relay-validated as the grantee's queue).

## The API (`support-api.service.ts`)

Served in process only; there is no Express route for `/api/support`, so no
HTTP caller (agent, dashboard, relay owner call) can present a support
identity, and a support caller never holds an owner credential. Paths are
relative to `/api`.

| Method, path | Role | Body `data` |
|---|---|---|
| `GET /support/whoami` | any | `{grantId, role, includePrivate, granteeEmail}` |
| `GET /support/conversations?limit=50&archived=1` | any | `{conversations: [{id, name, type, source, agentSession?, teamId?, createdAt, lastMessageAt, archived, external?}]}` newest first, max 200; `source` = slack / whatsapp / telegram / google-chat / shared / crewly |
| `GET /support/conversations/:id/messages?limit=50&cursor=&direction=backward` | any | `{conversationId, messages: [{id, seq, threadId?, senderType, senderId, createdAt, content, withheld, attachments (count), replyCount?}], nextCursor, prevCursor}`, max 200; metadata and attachment files are never returned |
| `GET /support/agents` | any | `{orchestrator: {sessionName, agentStatus, workingStatus, runtimeType, readyAt} \| null, teams: [{id, name, members: [{id, name, role, sessionName, agentStatus, workingStatus, runtimeType, ownerStopped, paused}]}]}` |
| `GET /support/errors?limit=100` | any | `{source: 'service.log', lines: [...]}`: WARN / ERROR / FATAL lines from the last 512 KiB of `<CREWLY_HOME>/logs/service.log`, max 500, each ≤ 600 chars |
| `GET /support/settings` | any | `{general, chat, skills, apiKeysConfigured}`: `SUPPORT_SETTINGS_ALLOWLIST` scalars only (no `runtimeCommands`, paths, browser profile), key presence per provider, never values |
| `POST /support/agents/:session/restart` | admin | `{session, restarted: true}`; 404 unknown agent, 409 owner-stopped or paused team, 500 did not come back |

Errors: `{success: false, code, error}`; unexpected failures are 500
`support_unavailable` with a secret-scrubbed message.

Restart reuses `ReloginAgentResumerService.resume([session])` (stop exit
monitoring, kill the PTY, keep the conversation id, `createAgentSession`; the
orchestrator through `OrchestratorRestartService`).

## Redaction (`support-redaction.ts`)

- **Always:** `redactSecrets` + the wiki `SECRET_PATTERNS` (Slack, OpenAI /
  Anthropic, GitHub, Google, AWS keys, JWT, bearer headers, private key
  blocks, `password=`, connection strings), credentials in URL query
  parameters, and 32+ character letter+digit runs (UUIDs kept).
- **Unless `includePrivate`:** the whole text becomes
  `[withheld: private content]` when the message metadata has a #969 mark
  (`visibleToPeople`, `visible_to_people`, `privateSourcePeople`), or the
  shared-channel classifier finds `children_data`, `children_mention`,
  `private_person_data` or `owner_connector`, or the text names an age,
  birthday / date of birth or school grade. Other texts get emails, phone
  numbers and ID numbers masked.
- Applied to message content, conversation names and error lines.

`privateSourcePeople` is new: `deliverReply` (reply-chat path) stores the
people whose connector grants the agent read inside the private-source window
(`PrivateSourceTracker.recentPeople`, the owner included) on every reply it
delivers, wherever it lands. A caller-supplied value is dropped.

## Audit (`support-audit.service.ts`)

Every call goes to the Activity log with actor `{type: 'support', id:
<granteeEmail>, via: 'support-grant'}`, target `{type: 'support-path', id:
<pathname>}` and `after: {method, path, outcome, status, code?, granteeEmail,
granteeAccountId, grantId, role, includePrivate}`. Actions: `support.read`
(GET ok), `support.action` (POST ok), `support.refused` (refused or failed).
A successful GET by the same grant on the same pathname is written once per
15 minutes (paging one conversation is one entry); refusals and actions are
always written. The activity API and Settings › Activity accept the new
`support` actor type.

## Kill switch

`settings.support.allowGrantees` (default `true`). Off refuses every support
call before anything is read. Set with `PUT /api/settings {"support":
{"allowGrantees": false}}` (owner only); the toggle UI comes with Settings ›
Access.

## Agent callers

`specs/2026-11-12-support-access-agent-read.md`: the envelope also carries
`actor` (`person`, the default, or `agent`) and an agent's `agentName`. An
agent caller is refused anything but a `GET` of conversations, agents or
errors (`support_agent_read_only`, `support_agent_path_refused`), and its
calls are audited as the grantee account's agent.

## Not in this slice

- Wiki pages are not served, so `visible_to_people` on pages is not yet used.
- Messages written outside `deliverReply` (Slack mirrors of humans, owner
  posts) carry no private mark; the shape detectors cover them.
- No grant list or revoke on the instance: Cloud owns grants and the relay
  re-reads them on every send.

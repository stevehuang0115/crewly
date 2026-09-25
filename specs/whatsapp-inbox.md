# WhatsApp Inbox Connector

Status: implemented on `feat/whatsapp-inbox` (2026-09-24). Not yet tested
against a live account.

## Owner decision (scope)

The owner has many WhatsApp messages on their **personal** account and wants
agents to help handle them. Decided scope:

- **Read and summarise**: which chats need a reply, what each chat says, search.
- **Write reply drafts.**
- **Nothing is ever sent without the owner's explicit confirmation**, one
  message at a time.
- **Never auto-reply to anyone.**

A personal number can only be read through the unofficial linked-device
protocol (Baileys, `@whiskeysockets/baileys`, an optionalDependency).
WhatsApp bans numbers for automated messaging. That is why sending is manual
and gated.

## Modes

`WhatsAppConfig.mode: 'assistant' | 'inbox'`.

| | assistant (pre-existing) | inbox (new) |
|---|---|---|
| Orchestrator bridge | started; routes every message to the orc and auto-replies | **not started**; torn down if left over |
| `message` event | emitted (text-only, non-own, allowed contacts) | **never emitted** |
| Storage | none | everything → `~/.crewly/whatsapp/inbox.db` |
| `allowedContacts` | filters | ignored (it is the owner's own account) |
| Agent `POST /send` | allowed | **403** `agent_send_forbidden_in_inbox_mode` |
| Socket | Baileys defaults | `markOnlineOnConnect:false` (phone keeps notifying), `syncFullHistory:false`, history chunks except FULL |

Defence in depth: `WhatsAppOrchestratorBridge.handleWhatsAppMessage` and
`sendWhatsAppResponse` return early when the service is in inbox mode.

### Choosing the mode

- `POST /api/whatsapp/connect {mode}` defaults to **inbox**; an invalid mode
  returns 400 `invalid_mode`.
- The chosen config is saved to `~/.crewly/whatsapp/connection.json` (0600)
  with `autoConnect: true`. `POST /disconnect` sets `autoConnect: false` and
  keeps the mode.
- At startup (`resolveStartupWhatsAppConfig`):
  - `WHATSAPP_ENABLED=true`: mode = `WHATSAPP_MODE` env, else the persisted
    mode, else `assistant` (what the env path has always meant).
  - Otherwise: reconnect the persisted config when `autoConnect` is true.

## Store

`backend/src/services/whatsapp/whatsapp-inbox.store.ts`, better-sqlite3, path
from `getCrewlyHomePath()` (so `CREWLY_HOME` isolates it). Directory 0700,
file 0600.

- `chats(id, name, name_rank, is_group, last_message_at)`. The name is only
  replaced by a source ranked at least as high: pushName (1) < chat or group
  subject (2) < address-book name (3). `last_message_at` only moves forward.
- `messages(id PK, chat_id, from_me, sender_jid, sender_name, text, ts ms, kind)`.
  `kind` is one of `text | image | document | audio | video | sticker | other`.
  The upsert is idempotent on id. A redelivery keeps `from_me`, `ts` and chat,
  and refreshes text (unless empty), kind and a newly learned sender name.
- `drafts(id, seq UNIQUE, code UNIQUE 'W'||seq, chat_id, text, status, created_at, created_by, sent_at, discarded_at, last_error)`.
  - Status is `pending → sending → sent`, falling back to `pending` (with
    `last_error`) when a send fails, or `pending → discarded`.
  - `claimDraftForSend` is an atomic `UPDATE … WHERE status='pending'`, so a
    draft can never be sent twice, even when requests race.

"Needs a reply" means the newest message in the chat is not `fromMe`.
`unansweredCount` counts inbound messages after the owner's last message in
that chat.

## Capture (inbox mode)

`whatsapp-inbox-capture.ts` maps Baileys events to the store:

| Event | Handling |
|---|---|
| `messages.upsert` (`notify` and `append`) | every message incl. `fromMe`, groups, media |
| `messaging-history.set` `{chats, contacts, messages}` | seeds chats, names and messages from the last 90 days |
| `contacts.upsert` / `contacts.update` | `name` (address book, rank 3), else `notify`/`verifiedName` (rank 1) |
| `chats.upsert` / `chats.update` | `name`, `conversationTimestamp` |
| `groups.upsert` / `groups.update` | `subject` |
| unknown group | one best-effort `sock.groupMetadata(jid)` per process |

- Content is unwrapped the way Baileys' `normalizeMessageContent` does it
  (ephemeral, viewOnce, viewOnceV2 and V2Extension, documentWithCaption,
  edited).
- Skipped: `status@broadcast`, protocol, reaction, sender-key and
  context-only envelopes, and messages without an id or timestamp.
- Media is never downloaded. It is stored as its kind plus the caption (the
  file name for documents).
- LID addressing: when `key.remoteJidAlt` / `participantAlt` gives the
  `@s.whatsapp.net` form of an `@lid` JID, the phone-number form is used, so
  one person maps to one chat.
- Timestamps may be a number, a numeric string, a bigint, or a protobuf Long.
  All are stored as epoch ms.
- Sent drafts are recorded immediately from `sock.sendMessage`'s return value,
  so the inbox shows the chat as answered.

## API (`/api/whatsapp`, `{ success, data }` / `{ success:false, code, error }`)

| Route | Notes |
|---|---|
| `GET /inbox?limit=&includeGroups=` | default 20 (max 200); groups off by default |
| `GET /chats?limit=&q=` | name/JID substring |
| `GET /chats/:chatId/messages?limit=&before=` | one page, oldest first; `nextBefore` for paging |
| `GET /search?q=&limit=` | LIKE over text (`%`/`_` escaped) |
| `POST /drafts {chatId, text}` | chat must exist; ≤ 4000 chars; `createdBy` = X-Agent-Session; returns code + `instruction` |
| `GET /drafts?status=` | adds `recipient` |
| `POST /drafts/:id/discard` | id or code |
| `POST /drafts/:id/send` | the gate below; sends are serialized |

Agents may call every route. `X-Agent-Session` is optional on the reads.

### Send gate (`whatsapp-draft-gate.ts`)

1. The draft must be `pending`. Otherwise 409 `draft_not_pending` (covers
   already sent and discarded).
2. **No `X-Agent-Session` header** means the owner (dashboard, mobile,
   portal). The call is allowed; the click is the confirmation.
3. **Agent caller** means the draft must be at most `DRAFT_CONFIRM_WINDOW_MS`
   (30 min) old, **and**
   `ChatV2Service.getRecentOwnerMessageContents(draft.createdAt)` (genuine
   owner messages across chat-v2, including mirrored Slack) must contain one
   matching `/^(发|发送|send|确认发送?)\s*#?(W?\d+)\s*$/i` whose code is this
   draft's.
   - That method returns contents only, with no timestamps. Every returned
     message therefore post-dates the draft, and bounding the draft's age
     bounds the confirmation to the same window.
   - Otherwise the answer is 403 `needs_owner_confirmation`, with
     `data.reason` = `no_confirmation` or `window_expired` and a message
     telling the agent to show the draft and ask for 「发 W12」.
4. Not connected: 503. Socket failure: 502 `send_failed`, and the draft goes
   back to `pending` with `last_error`.

Each send and refusal is logged (code, chat, agent session, via).

### Known limits of the gate

- The spec defines "owner" as "no `X-Agent-Session` header". An agent that
  hand-writes a `curl` without the header would pass. Skills always send the
  header, and `whatsapp-send` refuses to run without `CREWLY_SESSION_NAME`.
  A stronger check would be `requireOwnerToken` (the API token), which the
  mobile/portal relay does not carry today.
- The mobile relay allowlist (`MOBILE_API_ALLOWLIST`) does not include the
  `/whatsapp/drafts` routes, so the phone app cannot yet press 发送.

## Agent skills (`config/skills/agent/core/`)

- `whatsapp-inbox` lists the chats that need a reply.
- `whatsapp-read` covers one chat, `--q` search, and `--chats`.
- `whatsapp-draft` creates a draft. Its output is `sent:false` and a
  `nextStep` telling the agent to show the owner the recipient, the text and
  the code, and to ask for 「发 W12」.
- `whatsapp-send` sends with `--draft <id|code>`.
  - On `needs_owner_confirmation` it fails with a clear "NOT SENT" message.
  - It refuses without `CREWLY_SESSION_NAME`.

Every SKILL.md carries the rules:
- never send without 「发 <code>」;
- never auto-reply;
- summarise rather than paste chats into other channels;
- groups are low priority.

The connectors section of the agent prompt lists the four skills.

## Frontend

`Settings → WhatsApp` (`WhatsAppTab.tsx`):
- Connect uses `{mode:'inbox'}`.
- A bilingual explainer reads 只读+起草，发送前需要你确认；不会自动回复任何人,
  followed by a one-line linked-device / ToS note. Assistant mode shows a
  warning instead.
- Pending drafts are listed with 发送 / 丢弃 buttons. These are owner calls
  with `X-Crewly-Caller: dashboard` and no agent header.

## Verification status

The unit tests cover:
- the store and capture;
- every route, including the gate matrix: owner vs agent, with and without
  confirmation, wrong code, outside the window, already sent, concurrent
  sends, and socket failure;
- inbox mode not starting the bridge;
- the skills (python stubs);
- the tab.

**No live WhatsApp account has been exercised.** The Baileys event shapes
above come from the 7.0.0-rc.9 typings and source, not from observed
traffic.

# Unified Conversations + Cloud Store

**Date:** 2026-09-28 · **Status:** Draft for owner review · **Repos:** `crewly` (OSS), `services` (auth, relay), `web`

## 0. Owner's design (authoritative) and defaults chosen

1. On each machine, Crewly's conversation store is the **superset** of all channels. Slack, Crewly Chat, Google Chat, Telegram, WhatsApp and Cloud Talk are each a **subset**. The UI shows conversations per channel and merged per agent.
2. When signed in, **Crewly Cloud holds the biggest superset**: every conversation from every machine on the account. Cloud keeps its copy with a TTL of **7 days on free** and **90 days on pro**.
3. Talking to agents from Cloud (the portal Talk page, voice-first) goes **directly to the agent's machine**, like Crewly Chat, and **not through Slack**. Those messages are part of the superset.

Defaults I chose. Each is a decision recorded here and is easy to change:

| # | Decision | Where it bites |
|---|---|---|
| D1 | Message text and attachment names are **encrypted at rest** in Cloud (AES-256-GCM). Routing fields stay plaintext so they can be indexed. | §C.4 |
| D2 | Talk messages, and the agent replies to them, are **not mirrored to Slack**. | §A.3 G6 |
| D3 | If the machine is offline, Cloud **queues** the Talk message using the existing 24h undelivered-queue semantics and **tells the user**. | §D.3 |
| D4 | On first sign-in, the machine **backfills** its local history for the plan's TTL window (7 or 90 days). | §B.4 |
| D5 | The Cloud store lives as a **module inside the auth service**, not a new service. Auth already has the Mongo helper, SecretBox, plan resolution, `slack_instances` and a CELB2 upstream. | §C |
| D6 | Portal realtime uses **HTTP long-poll on a per-account cursor** (`?wait=` ≤25s), the same pattern the relay already runs across 2 nodes. SSE and WebSocket are deferred. | §D.4 |
| D7 | The machine key is `instanceId`. It equals the device id and the relay queue id. The agent key is `instanceId:agentSession`. | §C.3 |
| D8 | The owner's **personal** WhatsApp inbox (`whatsapp/inbox.db`) is **never synced**. Only agent conversations are synced. | §B.6 |

Path prefixes used below:
- `OSS:` = `crewly/backend/src/`
- `AUTH:` = `services/auth/src/`
- `RELAY:` = `services/relay/src/`
- `WEB:` = `web-wt-voice/src/`. The Talk page exists only on branch `rel-1.0.90` and has not reached `web` main yet. Main `web` has the same logic inline in `portal/agents/page.tsx`.

---

## A. OSS: one unified message log

### A.1 What exists today

**The store.** Everything goes into one SQLite file, `~/.crewly/chat.db`.
- Path is set at `OSS:services/chat-v2/config.ts:124`, overridable with `CREWLY_CHAT_DB_PATH` (`:197`).
- The schema is at `OSS:services/chat-v2/sqlite/chat-db.ts:129-236`:
  - `chat_channels` (`:130-153`): `id`, `agent_session`, `owner_user_id`, `type ∈ dm|channel|huddle`, `team_id`, …
  - `chat_messages` (`:162-180`): `id`, `channel_id`, `seq`, `sender_type ∈ user|agent|system`, `sender_id`, `content`, `content_type`, `created_at`, `metadata` (JSON), `mentions`, `thread_id`.
  - `chat_attachments` (`:193-202`, image only, with `local_path`).
  - `chat_channel_members` (huddle roster, `:228-233`).
- Idempotency is a partial unique index on `metadata.clientMessageId` (`:182-191`).

**The single writer already exists.** `ChatV2Service.recordTurn` (`OSS:services/chat-v2/chat-v2.service.ts:1600`) requires a `metadata.source` from a closed list: `web|slack|pty-runtime|in-process-runtime|reply-tool|system|telegram|google-chat` (`:214-225`, checked at `:1643-1658`). It emits `chat_message` on every new row (`:1677-1679`).

The 2026-05-14 spec (`specs/2026-05-14-unified-chat-message-store.md`) already retired `~/.crewly/chat/*.json`. `ChatService` is now a facade over chat-v2 (`OSS:services/chat/chat.service.ts:164-293`).

**How each channel is recorded today:**

| Channel / path | Inbound recorded? | Outbound recorded? | External ids kept |
|---|---|---|---|
| Crewly Chat web → agent | ✅ `sendMessage` `chat-v2.service.ts:1482` | ✅ reply via `reply-chat` → `/chat/agent-response` → `recordTurn` (`OSS:controllers/chat/chat.controller.ts:~459`); `reply-channel` → `/chat/channels/:id/messages` | — |
| Slack DM to a per-agent bot | ✅ `SlackAgentDmService.routeInbound` → the agent's **web DM channel** (`OSS:services/slack/slack-agent-dm.service.ts:287-331`) | ✅ the agent reply lands in chat-v2 first; `mirrorOutbound` then posts it to Slack (`:455`) | `slackChannelId`, `slackThreadTs`, `slackTs`, `slackUserId` |
| Slack team channel, @-mention or ad-hoc room | ✅ huddle via `SlackTeamChannelService.routeInbound` (`OSS:services/slack/slack-team-channel.service.ts:1108-1242`); thread roots via `findSlackThreadRoot` (`:1188`) | ✅ chat-v2 first → listener posts (`:1793-1850`, `skipChatV2Mirror`) | same, plus the remote agent session |
| Slack → orchestrator (everything else) | ✅ `persistSlackInbound` → channel `slack-<chan>-<ts>` (`OSS:services/slack/slack-orchestrator-bridge.ts:2214-2260`) | ✅ `reply-slack` → `/api/slack/send` → `recordSlackReplyBookkeeping` (`OSS:controllers/slack/slack.controller.ts:113-199`), deduped with `slackOutboundClientMessageId` (`OSS:services/chat-v2/legacy-dto.utils.ts:191`) | `slackChannelId`, `slackThreadTs` only |
| Telegram | ✅ `recordMessengerOwnerTurn` (`OSS:services/chat-v2/owner-inbound.utils.ts:69-97`; `OSS:services/telegram/telegram-orchestrator-bridge.ts:133-141`) | ❌ `telegramResolve` sends without recording (`:155-205`); the reply only reaches `~/.crewly/telegram-threads/` | `telegramChatId`, `telegramMessageId` |
| Google Chat | ✅ `OSS:services/messaging/google-chat-initializer.ts:114-119` | ❌ `adapter.sendMessage` plus the thread file only (`:160-180`); the `reply-gchat` skill → `/messengers/google-chat/send` (`OSS:controllers/messaging/messenger.routes.ts:109-131`) does no chat-v2 write | `gchatSpace`, `gchatThread`, `gchatMessage` |
| WhatsApp (assistant mode) | ⚠️ recorded, but tagged **`source:'slack'`**, and the channel id includes `Date.now()`, so a new channel is created per message (`OSS:services/whatsapp/whatsapp-orchestrator-bridge.ts:203-219, 280-296`) | ❌ `whatsappResolve` → `sendMessage` (`:235, 348`) | `chatId`, `contactName` |
| Cloud Talk | ⚠️ enters via relay `chat_request sendMessage` (`OSS:services/chat-v2/chat-v2.relay-adapter.service.ts:343-501`), recorded as `source:'web'`; not distinguishable from Crewly Chat | ✅ as agent reply | — |

### A.2 Machine identity available today

| Id | Definition | Where |
|---|---|---|
| `deviceId` | uuid + hostname, stored in `~/.crewly/device.json` | `OSS:services/cloud/device-identity.service.ts:21-33,113` |
| `instanceId` (Slack registry) | `= deviceId` | `OSS:services/slack/slack-instance-registry.service.ts:567-569` |
| relay `queueId` | `= deviceId` when it matches `^[A-Za-z0-9._:-]{1,128}$` | `RELAY:http-queue.ts:93,460-471`; `OSS:services/cloud/cloud-sync.service.ts:558-566` |
| `homeId` | truncated `sha256(crewlyHome)` | `OSS:services/core/crewly-home.utils.ts:79-81` |
| account | not stored locally; it is the JWT `sub` (= `users.googleId`) in `~/.crewly/cloud/config.json` | `OSS:services/cloud/cloud-client.service.ts:26-40`; pairing at `cloud-sync.service.ts:657-665` |

### A.3 Gaps to close

| # | Gap | Fix |
|---|---|---|
| G1 | Outbound messages on Telegram, Google Chat and WhatsApp are not recorded. | Call `recordTurn(senderType:'agent', source:<channel>, direction:'out')` in each resolve callback (telegram `:155-205`, gchat `:160-180`, whatsapp `:235,348`) and in `POST /messengers/:platform/send` (`messenger.routes.ts:109-131`). Idempotency key: `clientMessageId = <source>-out-<platformMessageId>`. |
| G2 | WhatsApp is tagged `source:'slack'` and gets a new channel per message. | Add `whatsapp` to the source enum. Use a stable channel id `whatsapp-<chatId>` (drop `Date.now()`). |
| G3 | Talk cannot be told apart from Crewly Chat. | Add `cloud-talk` to the source enum. Relay `sendMessage` params carry `origin:'cloud-talk'`, which the adapter passes through to metadata. |
| G4 | "Sender" is only `user`, `agent` or `system`. A Slack channel `user` may be someone other than the owner. | New column `sender_kind ∈ owner|agent|human|system`. `owner` when the source is web, cloud-talk, or a Slack/messenger user matching the owner identity used by the approval gate; otherwise `human`. |
| G5 | Slack team id is never stored. The orchestrator path drops `slackTs` and `slackUserId` (`slack-orchestrator-bridge.ts:2214-2260`). | Always write `slackTeamId`, `slackTs`, `slackUserId` (the field exists: `OSS:types/slack.types.ts:346`). |
| G6 | `SlackAgentDmService.mirrorOutbound` posts **every** agent message on a linked DM to Slack, skipping only `source==='slack'` (`slack-agent-dm.service.ts:455-458`). A Talk message lands on that same DM, so the agent's reply would go to Slack. That violates D2. | **Reply affinity:** mirror only when the latest owner turn on the channel has `source==='slack'`. If it was `cloud-talk` or `web`, don't mirror. One query on `recentTurns` (`OSS:services/chat-v2/sqlite/message.store.ts:459`). |
| G7 | There is no per-agent query. `listChannels` filters only by owner, type or team, and nothing is indexed on `sender_id`. | §A.5 |
| G8 | There is no durable record of what has been synced. | A `cloud_outbox` table, §A.4 |

### A.4 Minimal schema change (additive migration, same pattern as `applyPhaseAColumnUpgrades`)

```sql
-- chat_messages: first-class copies of what used to be hidden in metadata JSON
ALTER TABLE chat_messages ADD COLUMN source        TEXT;  -- slack|crewly-chat|cloud-talk|google-chat|telegram|whatsapp|system|runtime
ALTER TABLE chat_messages ADD COLUMN direction     TEXT;  -- in (to agent) | out (from agent) | internal
ALTER TABLE chat_messages ADD COLUMN sender_kind   TEXT;  -- owner|agent|human|system
ALTER TABLE chat_messages ADD COLUMN agent_session TEXT;  -- the agent this message is to/from (denormalised)
ALTER TABLE chat_messages ADD COLUMN ext_ref       TEXT;  -- JSON {slackTeamId,slackChannelId,ts,threadTs,slackUserId | telegramChatId,… }
CREATE INDEX IF NOT EXISTS ix_messages_agent_created ON chat_messages(agent_session, created_at DESC);

-- durable outbox: one row per insert/update that Cloud must see
CREATE TABLE IF NOT EXISTS cloud_outbox (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- monotonic local order
  message_id TEXT NOT NULL,
  op         TEXT NOT NULL CHECK(op IN ('upsert','delete')),
  enqueued_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_outbox_ins AFTER INSERT ON chat_messages
  BEGIN INSERT INTO cloud_outbox(message_id,op,enqueued_at) VALUES (NEW.id,'upsert',NEW.created_at); END;
CREATE TABLE IF NOT EXISTS cloud_sync_state (k TEXT PRIMARY KEY, v TEXT);  -- ackedSeq, backfillDoneAt, enabled
```

- The metadata `source` is mapped to the column source like this:
  - `web` becomes `crewly-chat`.
  - `reply-tool` takes the inbound channel's source.
  - `pty-runtime` and `in-process-runtime` become `runtime`, and are kept only if they are user-visible.
- `recordTurn` fills the new columns; callers don't change. One old-row backfill (`UPDATE … SET source = json_extract(metadata,'$.source')`) runs in the migration.
- The trigger means **every** writer produces an outbox row, including future ones and any path that bypasses `recordTurn`. `updateMessageMetadata` (`chat-v2.service.ts:413`) enqueues an `upsert` only when user-visible fields change (for example a delivery status).
- `agent_session` resolution:
  - DM or slack-* channel: `chat_channels.agent_session`.
  - Huddle: the sender if the sender is an agent; otherwise the channel's lead agent. Mentioned agents are copied into `mentions`.

### A.5 Per-agent merged timeline (OSS API)

`GET /api/chat/agents/:session/timeline?before=<createdAt>&limit=50&source=slack,cloud-talk`

- Returns messages where `m.agent_session = :session`, or `m.channel_id` is in the huddles the agent belongs to (`chat_channel_members`), in `created_at DESC` order.
- Each item is a `ChatMessageDTO` plus `{source, direction, senderKind, extRef, channelId, channelName}`.
- The desktop UI and mobile use it in place of the client-side `useMergedMessages` fan-out.
- Add `GET /api/chat/agents/:session/timeline` to `MOBILE_API_ALLOWLIST` (`OSS:services/cloud/mobile-api-relay.service.ts:79-175`) so old portals can use it during rollout.

---

## B. Machine → Cloud sync

### B.1 Transport: a new HTTPS ingest endpoint on auth, not the relay

| Option | Verdict |
|---|---|
| Relay queue (`/queue/send`) | ❌ Each queue caps at 100 messages (`RELAY:mongo-queue-store.ts:109`). The per-user token bucket is `RELAY_USER_RATE_LIMIT_PER_MIN`, default **60** (`RELAY:constants.ts:76`; `http-queue.ts:754-784`). Prod's 600 is env-only (not in repo). Backfill alone would blow it, and the relay is a mailbox, not a store. |
| **`POST /api/cloud/conversations/ingest` on auth** | ✅ Same Bearer JWT the machine already uses for `PUT /api/cloud/slack/instances/:id` (`OSS:services/slack/slack-instance-registry.service.ts:631`; `AUTH:auth.routes.ts:171`). Goes through the existing CELB2 `crewly_auth` upstream (`services/relay/DEPLOY.md:9-14`). Works on either node, no pinning. |

The relay stays the **downlink** (Cloud → machine) for Talk, §D.3.

### B.2 Ingest contract

```http
POST /api/cloud/conversations/ingest        Authorization: Bearer <cloud token>   Content-Encoding: gzip
{ "instanceId": "…", "homeId": "…", "crewlyVersion": "1.21.0",
  "batchId": "<uuid>", "mode": "live" | "backfill",
  "messages": [ {
     "localId": "msg-uuid", "op": "upsert",
     "channel": { "localId": "slack-C09-1727…", "kind": "dm|channel|huddle", "name": "…" },
     "agentSession": "dev-ella", "mentions": ["dev-sam"],
     "source": "slack", "direction": "in", "senderKind": "human",
     "sender": { "id": "U07…", "name": "Maya" },
     "ext": { "slackTeamId": "T…", "slackChannelId": "C…", "ts": "1727….1234", "threadTs": "…" },
     "threadLocalId": null, "text": "…", "contentType": "markdown",
     "attachments": [ { "kind": "image", "mime": "image/png", "size": 48213, "name": "shot.png" } ],
     "clientMessageId": "talk-8f3…",          // present when the message originated in Cloud Talk
     "createdAt": 1727…, "localSeq": 18233 } ] }
→ 200 { "ackedThroughLocalSeq": 18233, "accepted": 50, "duplicates": 0, "retentionDays": 90 }
```

**Batching**
- Flush when the outbox has 50 messages, 256 KB, or has been waiting 2 s, whichever comes first.
- After a failure, back off exponentially from 1 s up to 5 min.
- One request is in flight per machine.

**Ordering**
- Batches are sent in `cloud_outbox.seq` order.
- Cloud orders the timeline by `createdAt`, then by `(instanceId, localSeq)` as a tiebreak. Clock skew between machines only affects how the merged view interleaves, never correctness.

**Idempotency**
- The dedupe key is `(accountId, instanceId, localId)`, enforced by a unique index. Ingest is an upsert, so replaying a batch is harmless.
- When a message carries a `clientMessageId` that matches a Cloud-originated Talk message, it updates that document (status becomes `delivered`) instead of inserting a new one. §D.3

**Ack**
- The machine sets `ackedSeq` and then deletes outbox rows up to that seq.

**Attachments**
- v1 syncs **metadata only**: kind, mime, size and name. Binary blobs stay on the machine.
- The portal shows a placeholder: "image on Mac mini".
- Blob sync is an open question (O4).

### B.3 Live path in the OSS

A `ConversationCloudSyncService` lives in `OSS:services/cloud/`, next to `CloudSyncService`:
- It starts only when a cloud token exists and sync is enabled.
- It wakes on `chat_message` (`chat-v2.service.ts:1677`) and on a 10 s timer.
- It drains `cloud_outbox`.

**Disconnected behaviour**
- The outbox is on disk, so it survives restarts and offline periods with no loss.
- Cap: once the outbox holds more than 200k rows, it keeps only the newest rows within `retentionDays` and logs a gap marker. Cloud shows "history gap".

### B.4 Backfill (D4)

- **When it runs:** on the first successful ingest after sign-in, when `cloud_sync_state.backfillDoneAt` is unset, or when the account changes (per the machine-switch memory notes, a machine may change accounts).
- **What it sends:** it reads `chat_messages WHERE created_at >= now - retentionDays` in `created_at ASC` order, in pages of 500.
  - `retentionDays` comes from the 200 response of a zero-message ingest call. Cloud knows the plan.
  - Each page is sent with `mode:'backfill'`.
- **How fast:** at most 1 batch per second, and it yields to live batches (live batches go first).
- **Resume:** the cursor is stored in `cloud_sync_state.backfillCursor`.
- **Duplicates:** live messages recorded during the backfill are also in the outbox, and Cloud dedupes them.

### B.5 Bandwidth estimate

The average message is about 400 B of text plus 300 B of metadata, so about 0.7 KB of JSON, or about 0.3 KB gzipped.

| Profile | Messages/day | Live upload/day | 7-day backfill | 90-day backfill |
|---|---|---|---|---|
| Light (1 machine, orc + 2 agents) | 200 | ~60 KB | 0.4 MB | 5 MB |
| Heavy (3 machines, busy Slack rooms) | 3,000 | ~0.9 MB | 6 MB | 80 MB |

Request rate is about 1 per 2 s at peak, far below any limit. Even the heaviest backfill takes about 6 min at 1 batch/s.

### B.6 Privacy and kill switches

| Level | Control |
|---|---|
| Machine | `CREWLY_CLOUD_CONVERSATIONS=off` env, or a setting `cloudConversationSync: on|off` (default **on** when signed in; D-option O1). When off, the outbox still fills but is never drained. |
| Channel | `cloudConversationSync.excludeSources: ['whatsapp', …]`. The WhatsApp **inbox** store (`OSS:services/whatsapp/whatsapp-inbox.store.ts:144-149`) is never read (D8). |
| Account (Cloud) | `DELETE /api/cloud/conversations` wipes everything for the account. `PUT /api/cloud/conversations/settings {enabled:false}` makes ingest return `403 sync_disabled`, and the machine stops. |
| Sign-out / account switch | Clear `cloud_sync_state` and the outbox, and re-backfill under the new account. |

---

## C. Cloud store (auth service module `AUTH:conversations/`)

### C.1 Collections

These go in `MONGO_CONSTANTS.COLLECTIONS` (`AUTH:deps.ts:262-292`), with indexes created in `ensureIndexes()` (`AUTH:mongodb.service.ts:351-463`).

**`conversation_messages`**

```ts
{
  _id: ObjectId,
  accountId: string,            // users.googleId (same key as slack_instances.accountId, AUTH:deps.ts:843)
  instanceId: string, homeId?: string,
  localId: string, localSeq: number,
  agentKey: string,             // `${instanceId}:${agentSession}`
  agentKeys: string[],          // + mentioned agents (huddles) — multikey
  channel: { localId: string, kind: 'dm'|'channel'|'huddle', name: string },
  threadLocalId?: string,
  source: 'slack'|'crewly-chat'|'cloud-talk'|'google-chat'|'telegram'|'whatsapp'|'system'|'runtime',
  direction: 'in'|'out'|'internal',
  senderKind: 'owner'|'agent'|'human'|'system',
  senderId: string, senderNameEnc?: string,
  ext?: { slackTeamId?, slackChannelId?, ts?, threadTs? },      // plaintext: needed for dedupe with Slack events
  textEnc: string,              // SecretBox v2 ciphertext (D1)
  contentType: string,
  attachments: { kind, mime, size, nameEnc }[],
  clientMessageId?: string,
  status?: 'queued'|'delivered'|'expired',                      // Talk-originated only
  createdAt: Date, receivedAt: Date,
  cseq: number,                 // per-account monotonic cursor for realtime (C.2)
  expiresAt: Date               // TTL (C.2)
}
```

**Indexes**
```
{ accountId:1, instanceId:1, localId:1 }            unique   – ingest dedupe
{ accountId:1, clientMessageId:1 }                  unique, partial(clientMessageId exists) – Talk ack
{ accountId:1, agentKeys:1, createdAt:-1 }                   – per-agent timeline
{ accountId:1, cseq:1 }                                      – realtime cursor
{ accountId:1, instanceId:1, "channel.localId":1, createdAt:-1 } – per-channel view
{ expiresAt:1 }  expireAfterSeconds:0                         – TTL
```

**Other new collections**

| Collection | Contents | Indexes |
|---|---|---|
| `conversation_counters` | `{_id: accountId, cseq}`. Advanced by `findOneAndUpdate $inc: {cseq: n}`, once per batch (n = batch size). | `_id` |
| `talk_undelivered` | Same shape as `slack_events_undelivered` (`AUTH:deps.ts:934-944`): `{accountId, instanceId, messageId, payload, attempts, lastError, createdAt, expiresAt}` | `{accountId, instanceId, createdAt}`; `{expiresAt} TTL 0` (24h, reuses `UNDELIVERED_TTL_S`, `AUTH:deps.ts:498`) |
| `waiting_items` (§F) | ticket snapshots | `{accountId, instanceId, ticketId}` unique; `{accountId, updatedAt:-1}` |
| `conversation_settings` | `{_id: accountId, enabled, retentionOverrideDays?}` | `_id` |

### C.2 TTL with per-plan retention

- `expiresAt` is computed at insert: `createdAt + retentionDays(plan)`, capped at `receivedAt + retentionDays`. Messages older than the window are never inserted, so backfills of old rows are dropped at ingest.
- `retentionDays(plan)`: `'free'` → 7; every paid value → 90. The paid values are `pro`, `max`, `starter`, `solo`, `team`, `full`, `enterprise` (`VALID_PLANS`, `AUTH:admin.controller.ts:156`).
  - **Prerequisite bug fix:** `resolveUserPlan` accepts only `solo|team|full` (`AUTH:jwt-auth.middleware.ts:56-78`, line 67). A user whose stored plan is `'pro'` (the only paid value payments writes, `services/payments/src/payment.types.ts:25`) resolves as `free`. Retention must read `users.plan` through a new `isPaidPlan()` that accepts `pro`, and `resolveUserPlan` gets the same fix.
- **Plan change** hooks into `internalUpdatePlan` → `updateUserPlan` (`AUTH:admin.controller.ts:458`, `AUTH:cloud-auth.service.ts:430-440`), which is fed by the Stripe webhook `syncPlanToAuthService` (`services/payments/src/stripe.service.ts:344`).
  - Recompute with a pipeline update, batched per account:
    ```js
    updateMany({accountId}, [{ $set: { expiresAt: { $add: ['$createdAt', days*864e5] } } }])
    ```
  - **Upgrade** (7 → 90): only messages still alive get the longer life, so history older than 7 days is already gone. The machine can re-backfill: the ingest response carries a new `retentionDays`, and the machine starts a backfill for the larger window. That makes an upgrade recover up to 90 days, as long as the machine still has the history.
  - **Downgrade** (90 → 7): the recompute makes older messages expire at the next TTL sweep, which runs every 60 s. Grace period is open question O2.
- The Mongo TTL monitor deletes at most about 60 s late. Reads also filter `expiresAt > now`.

### C.3 Multi-machine account model

| Collection | Today | Role in this design |
|---|---|---|
| `slack_instances` (auth) | `{accountId, instanceId, deviceName, relayQueueId, primary, teams[].agents/leader, rooms[], awakeAgents[], crewlyVersion, lastSeenAt}` (`AUTH:deps.ts:843-859`). Heartbeat every 5 min from OSS (`slack-instance-registry.service.ts:164`); live means seen within 15 min (`AUTH:slack-instances.service.ts:341`, `deps.ts:500`) | **The machine registry.** Add `roster[] = {agentSession, displayName, role, runtime, status}` so agents not on Slack are listed too. `parseRegistration` (`:119-176`) tolerates unknown fields, so old machines are unaffected. |
| `relay_queues` (relay) | `queueId = deviceId`, `lastActivityAt` refreshed by every long-poll (≤20 s) (`RELAY:mongo-queue-store.ts:56-75`) | **The fastest presence signal.** A machine is online when `lastActivityAt > now - 60s`. Auth already reads relay collections (`relay_clients`, `AUTH:deps.ts:276-277`). Same database is required: relay defaults to db `crewly` (`mongo-queue-store.ts:176`) while auth defaults to `CrewlyAI`. **Verify prod env** before relying on it. |
| `slack_agent_apps` (auth) | per-agent Slack app, display names (`AUTH:deps.ts:760`) | Display name and avatar source |
| `relay_clients` | registration stats | not used |

`agentKey = instanceId:agentSession` keeps same-named agents on different machines apart.

### C.4 Encryption at rest (D1)

- Reuse `SecretBox` (`AUTH:secret-box.ts`): AES-256-GCM, 12-byte IV, `v1.<iv>.<tag>.<data>` (`:18-20,87`).
  - Add **`v2.<kid>.<iv>.<tag>.<data>`** with a key id, so a message key can rotate without rewriting data. `decrypt` currently rejects anything that isn't v1 (`:101-103`).
  - The key comes from a **new env var `CREWLY_CONVERSATIONS_KEY`** (plus an optional `…_PREV` for rotation). It is separate from `CREWLY_SECRETS_KEY`, which guards OAuth tokens, so the blast radius stays separate.
- What gets encrypted: `text`, sender display name, attachment names.
- What stays plaintext: ids, source, direction, timestamps, Slack ext ids.
- Consequence: **no server-side full-text search**. Search is client-side over the IndexedDB cache (open question O5).

### C.5 Size and cost

About 1.2 KB per document: roughly 0.55 KB of ciphertext as base64, plus fields, plus about 0.3 KB of index overhead.

| | Messages retained | Storage/account |
|---|---|---|
| Free, light | 7 × 200 = 1.4k | ~2 MB |
| Pro, heavy | 90 × 3,000 = 270k | ~320 MB |

1,000 free accounts plus 100 heavy pro accounts comes to about 34 GB. That exceeds the current Mongo tier, and storage growth is the main cost risk (§G risks). A per-account soft cap of 500k messages is enforced at ingest: the oldest are dropped first and the response flags `capped:true`.

---

## D. Cloud API for the portal

Routes are mounted under `/api/cloud/conversations` on the auth router (`AUTH:index.ts:29`). All use `requireAuth` (portal JWT from `localStorage.crewly_access_token`, `WEB:contexts/AuthContext.tsx:42`), with `accountId = req.user.id`.

### D.1 Endpoints

| Method + path | Purpose |
|---|---|
| `GET /agents` | All agents across the account's machines, with presence (D.2) |
| `GET /agents/:agentKey/timeline?before=<iso>&limit=50&sources=` | Paged merged timeline, newest first, decrypted |
| `GET /channels/:instanceId/:channelLocalId/messages?before=&limit=` | Per-channel view (for example one Slack thread) |
| `POST /agents/:agentKey/messages` `{clientMessageId, text, voice?:true}` | Talk send (D.3). Returns `{message, status:'queued'|'sent'}` |
| `GET /stream?since=<cseq>&wait=25000` | Realtime long-poll (D.4). Returns `{events:[message|status|presence|waiting], cseq}` |
| `GET /waiting` | "Waiting on you" across machines (§F) |
| `POST /waiting/:instanceId/:ticketId/{verify|reject}` `{reason?}` | Ticket action, routed like a Talk send |
| `GET/PUT /settings`, `DELETE /` | Enable/disable, wipe (§B.6) |
| `POST /ingest` (machine) | §B.2 |
| `POST /waiting/ingest` (machine) | §F |

### D.2 Agents and presence

- Built from `slack_instances` (`roster[]`, with fallback to `teams[].agents ∪ rooms[].agents`) joined with `relay_queues.lastActivityAt`, `awakeAgents` and the latest timeline message per agent.
- Per agent: `{agentKey, instanceId, deviceName, agentSession, displayName, machineOnline, awake, lastMessage:{textPreview, at, source}, unread}`.
- The machine presence states are:

  | State | Condition |
  |---|---|
  | online | relay activity within the last 60 s |
  | stale | seen within 15 min |
  | offline | otherwise |

### D.3 Talk send path (D2, D3)

```
portal ──POST /agents/:key/messages──► auth
  1. insert conversation_messages {source:'cloud-talk', direction:'in', senderKind:'owner',
     clientMessageId, status:'queued'}; bump cseq → portal sees it in the stream
  2. if machine online: push relay payload {type:'talk_message', messageId, clientMessageId,
     agentSession, text} to slack_instances.relayQueueId via the account's virtual relay
     device (same mechanism as SlackRelayPushService, AUTH:slack-relay-push.service.ts:97-187)
     else: insert talk_undelivered (24h) and return status:'queued', machineOnline:false
  3. replayed on heartbeat exactly like replayUndelivered (AUTH:slack-routing.service.ts:468-498,
     hook in slack-instances.controller.ts:39-41)
machine: CloudSyncService receives talk_message
  4. recordTurn into the agent's DM (ensureDmChannel, same channel the web UI + Slack DM use,
     OSS:services/slack/slack-agent-dm.service.ts:287-331) with source 'cloud-talk',
     metadata.clientMessageId = clientMessageId (idempotent via uq_messages_client_id)
     – orchestrator target: ChatService.sendMessage path (OSS:services/chat/chat.service.ts:164)
  5. dispatcher wakes the agent (chat-v2.dispatcher.service.ts:368-434)
  6. outbox → ingest; Cloud matches clientMessageId → status:'delivered' (stream event)
  7. agent replies via reply-chat → recordTurn(out) → G6 affinity rule keeps it off Slack
     → outbox → ingest → stream → portal
```

**Old machines.** These are machines older than the version that ships `talk_message`, as reported by `slack_instances.crewlyVersion`.
- Cloud falls back to sending a relay `chat_request {method:'sendMessage', params:{channelId, content, clientMessageId}}` from its virtual device.
- The adapter replies to `msg.from || msg.fromDeviceName` (`OSS:services/chat-v2/chat-v2.relay-adapter.service.ts:273`). **To verify in phase 3:** that it accepts a request from a queue it has not seen before. Its "known devices" registry registers on first `chat_request` (`:15-27`), which suggests it does.
- Replies from old machines only reach Cloud if the machine runs ingest. Before that, the portal keeps the relay-RPC timeline for that machine (§E flag).

**User messaging on queue.**
- Bubble: "Mac mini is offline — will deliver when it's back (up to 24h)".
- If the message expires in `talk_undelivered`, set `status:'expired'` and show "Not delivered".

**Rate limit.** Relay pushes from the virtual device use a token signed for the account (`signRelayToken({id: accountId})`, `slack-relay-push.service.ts:69`). They therefore share the per-user 60/min bucket with Slack event pushes and the portal's other relay pages. Talk is human-paced, so this is fine. The risk is covered in §G.

### D.4 Realtime: long-poll on `cseq` (D6)

| Option | Behind CF + CELB2 + 2 nodes |
|---|---|
| SSE | Needs `proxy_buffering off` / `X-Accel-Buffering: no` and a long `proxy_read_timeout` on CELB2's `/api/`. The only config in the repo sets `/api/` to a 60 s read timeout with buffering on (`crewly/deploy/nginx/api.crewlyai.com.conf:131`), and the real CELB2 conf is not in the repo. It also needs cross-node fan-out. |
| WebSocket | `/relay` already has upgrade headers (`:66-80`), but the relay WS registry is per-process with no cross-node sharing (`RELAY:relay-server.ts:78`), and routing needs `hash $arg_rk` (`services/relay/DEPLOY.md:82-93`). |
| **Long-poll** ✅ | Already proven on exactly this path. Relay `pollWaiting` (`RELAY:http-queue.ts:839-911`) uses an in-process emitter plus a **1 s Mongo re-check** (`LONG_POLL_RECHECK_MS`, `:76`) to catch writes landing on the other node, with a 25 s cap (`:67`) and a per-user held-poll cap (`:699-706`). The portal already long-polls with `wait=20000` (`WEB:hooks/useRelayChat.ts:75`). No nginx change. |

**Implementation**
- `GET /stream?since=N&wait=25000`:
  - Query `{accountId, cseq: {$gt: N}}` (indexed) and return immediately if anything matches.
  - Otherwise wait on an `EventEmitter` keyed by `acct:<id>`, fired by ingest and send on the same node, re-checking Mongo every 1 s. Return an empty result at 25 s.
- Cap: 4 held polls per account, as in relay.
- Status changes (queued → delivered) and presence changes also bump `cseq`. They are written as tiny event docs in `conversation_events` (TTL 1 h), so the stream reads one cursor.
- Upgrade path: switch to SSE later behind the same cursor once CELB2 is confirmed. The cursor semantics stay the same.

---

## E. Talk UI rework (`web`, from branch `rel-1.0.90`)

**Today** (`WEB:components/cloud/talk/TalkView.tsx`, 606 lines):
- Agents come from `client.listAgents()` every 30 s (`:143-172`).
- Slack threads are limited to the 8 most recent `slack-*` channels (`:156-164`; `WEB:hooks/useRelayChat.ts:317-332`, capped after 30+ threads blew the relay budget).
- Opening an agent calls `ensureDmChannel` (`:174-200`).
- The timeline issues N parallel `listMessages(limit:100)` calls, followed by client-side dedupe with a 10 s window (`useRelayChat.ts:146-184, 242-272`).
- Sends use relay `sendMessage` (`:261-275`), with a 10 s RPC timeout (`WEB:services/relay-chat-client.ts:274`).
- The client is pinned to one machine via a peer picker (`WEB:services/relay.service.ts:398-475`; `TalkView.tsx:397-417`).
- Nothing is cached, so every open refetches over the relay.

**New data layer** (`WEB:services/conversations-client.ts` + `WEB:hooks/useConversations.ts`):

| Concern | Plan |
|---|---|
| Fetch | `fetch` to `https://api.crewlyai.com/api/cloud/conversations/*` with Bearer (same pattern as `WEB:services/cloud.service.ts:31,79-84`), with 401 → refresh via `AuthContext` (`:65-80`) |
| Cache | IndexedDB (native API, no new deps). Stores are `agents` and `messages` (key `[agentKey, createdAt, id]`, last 300 per agent) plus `meta.cseq`. First paint comes from cache; the delta is fetched with `/stream?since=`. The cache is cleared on sign-out and account switch. |
| Realtime | A single long-poll loop per tab, paused when the tab is hidden (`visibilitychange`) and resumed with an immediate catch-up |
| Optimistic send | `clientMessageId = talk-<uuid>`. Render as `pending` immediately; the send response flips it to `queued` or `sent`; the `delivered` stream event adds a tick; failures get a retry button. The existing `pending/failed` visuals (`relay-chat-client.ts:472-498`) are reused. |
| Skeletons | Agent list and timeline skeletons show only when the cache is empty |
| Source badges | A small chip per message (Slack, Chat, Talk, Google Chat, Telegram, WhatsApp) using `source`, plus a "via #channel" line for Slack channel messages. Filter chips come from the `sources=` param. |
| Multi-machine | Agents are grouped by `deviceName` with a machine presence dot. The **peer picker is removed from Talk**. An offline machine greys its agents but keeps them sendable (queued). |
| Voice | `useSpeechInput`, `HoldToTalk` and `useReadAloud` are unchanged. `useReadAloud` should prime its seen-set from the IndexedDB cache so cached history is not read aloud (`WEB:components/cloud/talk/useReadAloud.ts:57-131`). |
| Waiting on you | `InboxList` reads `GET /waiting` and gets deltas from the stream, instead of `listTickets` over the relay every 30 s (`TalkView.tsx:217-257`) |

**Delete from the Talk path** once all of the account's machines run ingest; until then this sits behind a per-machine flag:
- `useRelayChatClient`, `useMergedChannelMessages`, `mergeChannelIdsFor`, `recentSlackChannelIds`, `dedupeNearDuplicates`, `toChronological` (`WEB:hooks/useRelayChat.ts`).
- Talk's use of `RelayContext` peer selection.

**Keep:**
- `relay-chat-client.ts` and `useRelayApi.ts`. Desktop, browser, slack, backups and tickets pages still use them (`WEB:hooks/useRelayApi.ts:45-66`).
- `useRelayChat.ts`, until `portal/agents/page.tsx` also migrates. It imports these helpers (`agents/page.tsx:34-37,138-146`).

**Separate cleanup:** the dead Redis relay routes `WEB:app/api/v1/relay/*`. The only consumer is `app/[locale]/cloud/dashboard/page.tsx:115`.

**Fallback:** if `GET /agents` reports a machine with `ingest:false` (version too old), Talk uses the legacy relay-RPC hooks for that machine only.

---

## F. "Waiting on you" (tickets in `to_review`) synced to Cloud

- `to_review` is **derived, not stored**. Tickets are `Request` JSON files at `<projectDataDir>/.crewly/requests/<id>.json` (`OSS:services/v3/request.service.ts:35,144`). The board column comes from `deriveBoardColumn` (`OSS:types/v2/ticket.types.ts:301-330`): it is `to_review` when `requiresConfirmation` is set and all work items are done or verified, or when the ticket is `waiting_confirmation` with no work items.
- **Machine side:**
  - A `WaitingItemsSyncService` recomputes the `to_review` set on `RequestService.update` (`:401`) and work-item status changes, debounced by 2 s, plus a sweep every 5 min.
  - It POSTs `/api/cloud/conversations/waiting/ingest {instanceId, items:[{ticketId, ticketNumber, title, summary, ownerAgent, assignee, projectName, column, updatedAt}], full:boolean}`.
  - `full:true`, sent on the sweep and after a restart, replaces the machine's whole set, so items that left `to_review` are deleted.
- **Cloud side:**
  - `waiting_items` stores `titleEnc` and `summaryEnc` under the same retention rule. Upserts and deletes bump `cseq` as `waiting` events.
- **Actions:**
  - `POST /waiting/:instanceId/:ticketId/verify|reject` pushes the relay payload `{type:'ticket_action', action, ticketId, reason, actionId}`, queued if the machine is offline.
  - The machine calls the existing `TicketIntakeService` verify/reject path, the same code behind `POST /api/tickets/...` (`OSS:controllers/tickets/tickets.routes.ts`; allowlisted at `OSS:services/cloud/mobile-api-relay.service.ts:79-175`).
  - The resulting status change flows back through the waiting ingest.
- Ticket mechanics stay internal to the owner (per the "tickets are internal" note). The portal shows only the agent's plain-language summary and "OK / Send back".

---

## G. Phased delivery

| Phase | Ships | Repo | Test plan |
|---|---|---|---|
| **P1: Unified local log** | Schema migration (§A.4), outbox trigger, source enum `+cloud-talk +whatsapp`, G1 (outbound Telegram/GChat/WhatsApp recorded), G2 (WhatsApp source/channel), G4 `sender_kind`, G5 Slack ids, G6 Slack reply-affinity, per-agent timeline API + allowlist. No Cloud traffic yet. | crewly | Migration test on a copy of a real `chat.db` (idempotent, old rows backfilled). Unit tests per channel asserting one in-row plus one out-row with the right `source`, `direction` and ext. The G6 test: a Talk-sourced turn must not produce a Slack post; a Slack-sourced one must. Timeline endpoint: pagination and huddle membership. |
| **P2: Cloud store + ingest** | `AUTH:conversations/` module: collections, indexes, TTL, SecretBox v2 + `CREWLY_CONVERSATIONS_KEY`, `POST /ingest`, `GET /agents`, `GET /timeline`, `GET /stream`, plan retention + `resolveUserPlan` `pro` fix + plan-change recompute. OSS `ConversationCloudSyncService` (live + backfill), default **off** behind `CREWLY_CLOUD_CONVERSATIONS=on`. | services (auth), crewly | Jest with mongodb-memory-server: dedupe replay, TTL `expiresAt` math per plan, upgrade/downgrade recompute, encryption round-trip + v1/v2 decrypt, stream across two app instances sharing one Mongo (proves the 1 s re-check). OSS: outbox drain, offline accumulate, 401 or `sync_disabled` handling, backfill resume. Deploy auth to both nodes (surgical `docker compose up -d`, per the deploy notes), then enable on the owner's machines only. |
| **P3: Talk send via Cloud** | `POST /agents/:key/messages`, `talk_message` relay push + `talk_undelivered` + heartbeat replay, OSS `talk_message` handler → DM/orc `recordTurn(cloud-talk)` → dispatcher, delivered-ack via `clientMessageId`, old-machine fallback via `chat_request`. `slack_instances.roster[]` in heartbeat. | services, crewly | Machine online: send → reply round-trip under 3 s plus agent think time. Machine offline: queued → heartbeat → delivered; expiry after 24h → `expired`. Same message twice (retry) → one row locally and in Cloud. Owner-DM Slack thread untouched by the Talk exchange (D2). Two machines with the same agent name → routed by `agentKey`. |
| **P4: Talk UI on Cloud** | New client + IndexedDB cache + long-poll + optimistic send + skeletons + badges + multi-machine list. Per-machine fallback to relay RPC. Remove the peer picker from Talk. | web | Unit: cache merge and ordering, optimistic reconcile, stream resume after `visibilitychange`. Playwright on the PWA: cold load from cache under 300 ms, a Slack message sent in Slack appears in Talk within about 3 s, send with the machine offline shows the queued banner. Deploy web to both nodes surgically. |
| **P5: Waiting on you + cleanup + default-on** | §F sync and actions. Flip sync default **on** for signed-in machines. Migrate `portal/agents` to the Cloud API. Delete the Talk relay-RPC path and the dead `app/api/v1/relay/*`. Admin stats: storage per account. | crewly, services, web | Ticket to `to_review` → appears in the portal within 5 s. Verify from the portal → ticket done on the machine → disappears. `full:true` sweep removes stale items. Load test: 50 synthetic accounts × 3k msgs/day ingest + 200 held polls on both nodes. |

**Rollout order:** P1 (OSS release) → P2 auth deploy → P2 OSS release (flag off) → owner machines on → P3 → P4 → P5.

Old machines keep working throughout:
- Cloud APIs only report data for machines that ingest.
- The portal falls back per machine to the relay RPC path.
- The `talk_message` relay type is ignored by old OSS. Cloud checks `crewlyVersion` before choosing it.
- New fields in the heartbeat are optional (`parseRegistration`).

Lagging machines are a known issue (see the machine-version-drift note), so the fallback stays until `slack_instances.crewlyVersion` shows every live machine is on the new version.

**Risks**

| Risk | Mitigation |
|---|---|
| **Relay per-user rate limit.** One 60/min bucket per node per account (`RELAY:constants.ts:76`) is shared by portal relay pages, Slack pushes and Talk pushes. Prod's 600 is env-only and silently reverts if the env is lost. | Ingest and reads don't use the relay at all, so the budget drops sharply once P4 lands. Check the 600 into the deploy env template. Talk pushes retry on 429 with `Retry-After`. |
| **Slack events already route through Cloud.** Duplicates appear if Cloud also stores raw Slack events. | Cloud stores **only what machines ingest**, never raw Slack events. `ext.{slackChannelId, ts}` is kept so a Slack message seen by two machines (a shared room, per the shared-rooms note) can be collapsed in the timeline view: group by `(slackChannelId, ts)`. |
| **Storage growth**, estimated at 34 GB at 1.1k accounts (§C.5) | Hard TTL, the 500k per-account cap, metadata-only attachments, and an admin storage stat in P5 |
| **PII.** Slack channels contain other humans' messages; WhatsApp contacts. | Encryption at rest (D1). WhatsApp inbox never synced (D8). Per-source exclude. Account wipe endpoint. Privacy policy text update (owner). |
| **Cross-machine `relay_queues` read from auth.** The two services may use different Mongo DBs (`crewly` vs `CrewlyAI`). | Verify in prod before P2 presence. Fallback presence = `slack_instances.lastSeenAt` plus `lastIngestAt`. |
| **Plan string mismatch** (`pro` vs `solo|team|full`) | Fix in P2 with tests (C.2) |
| **Clock skew** between machines garbles the merged order | Order by machine `createdAt`, capped to `receivedAt ± 5 min` |
| **The one-SecretBox-key pattern has no rotation** today | v2 format with `kid` + `_PREV` key |

---

## Open questions (need the owner)

- **O1.** Default for existing signed-in machines: sync **on** automatically once P5 ships, or require an explicit opt-in (a one-tap phone prompt, per the owner-away rule)? Proposed: on, with a one-time DM notice and a "turn off" link.
- **O2.** Downgrade pro → free: delete history older than 7 days immediately, or keep a 30-day grace period (as `retentionOverrideDays`) so a lapsed card doesn't wipe 90 days?
- **O3.** Should other humans' messages in shared Slack channels be synced to Cloud (they're in the local superset), or only messages to or from the owner's agents? Proposed: sync everything the machine recorded, since that is the owner's literal "superset".
- **O4.** Attachment blobs in Cloud (images/files sent via Slack or Talk)? Proposed: v1 metadata only; blobs later (DO Spaces like backup) as a pro feature.
- **O5.** Accept "no server-side search" as the cost of encryption at rest? Proposed: yes for v1; client-side search over the cache.

## Owner decisions (2026-09-28) — authoritative, supersede open questions
- O1 Sync: ON automatically for already-signed-in machines (one-time DM notice that history now syncs).
- O2 Pro→free downgrade: keep history 30 days grace, then apply the 7-day window.
- O3 Shared Slack channels: store only messages involving the account's agents (owner→agent, agent→anyone, and messages @-mentioning an agent). Do not store other people's chatter.
- O4 Attachments: text only in v1 (attachment name/size/mime metadata, no file bytes).
- O5 Encryption at rest accepted; no server-side full-text search (search later from the phone's local cache).
- Also: fix `resolveUserPlan` so plan `pro` is recognised; codify the relay per-user rate limit default as 600/min in code (not only env).

## Implementation notes — machine side (P1 + P2 uploader, branch `feat/unified-conversation-log`)

- **Schema** (`OSS:services/chat-v2/sqlite/unified-log.ts`): §A.4 columns plus `cloud_sync INTEGER` (1 = may leave the machine, 0 = O3 chatter). Indexes `ix_messages_agent_created`, `ix_messages_created`. Triggers: insert → `upsert`; update of `content`, or `cloud_sync` rising to 1 → `upsert`; delete → `delete`. All skip `cloud_sync = 0`. Legacy rows are backfilled in JS (same derivation as live inserts), never enqueued — the first-sign-in backfill uploads them.
- **Derivation** happens in `MessageStore.insert`, so every writer gets the columns. Agent replies take the `source` of the channel's latest `user` row (reply-tool, pty, in-process alike); `runtime` only when there is none. A messenger channel prefix (`whatsapp-`, `telegram-`, `gchat-`) wins over a wrong legacy tag.
- **O3 on the machine**: in a `huddle`/`channel` room, a Slack `user` row that is not the owner (`slackUserId` ≠ the workspace installer) and mentions no agent gets `cloud_sync = 0` and `direction = 'internal'` (it stays in the local log). Owner rows written before the owner id was known are reclassified by `reclassifyOwnerSlackRows` (on wiring and before a backfill).
- **G6** reads `ChatV2Service.getLatestOwnerTurnSource` (rows with `sender_kind = 'owner'`); `mirrorOutbound` posts only when it is `slack`.
- **G3**: relay `sendMessage` params `origin: 'cloud-talk'` → `metadata.source = 'cloud-talk'` (owner turns only). `recordCloudTalkTurn` (`owner-inbound.utils.ts`) is the Phase 3 hook for `talk_message`.
- **Timeline**: `GET /api/chat/agents/:session/timeline?before=<ms>|cursor=&limit=&source=` → `{agentSession, items, nextCursor}`; an agent principal may read only its own.
- **Uploader** (`OSS:services/cloud/conversation-cloud-sync.service.ts`, contract in `conversation-ingest.contract.ts`, mirroring `AUTH:conversations/contract.ts`): on by default when signed in (O1), kill switch `CREWLY_CONVERSATION_SYNC=0` (or `CREWLY_CLOUD_CONVERSATIONS=off`). Backfill `localSeq` is 0. `clientMessageId` is sent only for `cloud-talk` rows (Cloud's index on it is unique per account). Empty-batch probe gets `retentionDays`; a larger value later re-runs the backfill (upgrade). Account switch (JWT `sub` change) clears the outbox and state except `noticeSentAt`. 404 / `403 sync_disabled` / `503 conversations_key_missing` / `400` → pause 1 h, logged once; 401 → token refresh + backoff; 413 → halve the batch, drop a single unsendable message; other errors → 1 s…5 min backoff. The O1 DM goes out after the first 200 via `createOwnerDirectDm`.


## Implementation notes — Talk send via Cloud (P3, branch `feat/cloud-talk-send`, crewly + crewly-services)

**Send contract (fixed; the portal is built against it).** `POST /api/cloud/conversations/agents/:agentKey/messages` (portal JWT) `{text: 1..8000 chars, clientMessageId: [A-Za-z0-9._:-]{1,128}, source?: 'cloud-talk', inputMode?: 'voice'|'text'}` → `201 {success, data: {message, status: 'queued'|'sent'}}`. `message` is a timeline DTO; Talk messages carry `delivery: {state: 'queued'|'sent'|'delivered'|'failed', queuedReason?: 'machine_offline'|'relay_unavailable', error?, at?}` and `inputMode`. Idempotent on `clientMessageId` (a retry returns the stored message, 201; the same id to another agent is 400). Errors: 400 `invalid_request`, 401, 404 `agent_not_found`, 409 `machine_not_synced` (the machine never uploaded conversations) or `machine_outdated` (it does not advertise `talk_message`), 429 `rate_limited` (30/min/account, `Retry-After`), 503 `conversations_key_missing`. Every delivery change gets a new `cseq`, so `GET /stream` returns `{type:'message', cseq, message, clientMessageId}`.

**Routing (AUTH:conversations/talk.service.ts).** The target machine comes from `ConversationStoreService.machines()` (Slack registry ∪ conversation uploads ∪ relay presence). "Reachable" = relay long-poll within 60 s when `relay_queues` is readable, else a heartbeat or upload within 15 min (the Slack routing rule). Reachable → `SlackRelayPushService.pushPayload(account, relayQueueId || instanceId, 'talk_message', {v:1, messageId, clientMessageId, instanceId, agentSession})` from the account's virtual relay device → `sent`. The push carries **no text**: the machine fetches it with its own token (`GET /talk/:messageId?instanceId=`, 404 unless the message is on that account and for that machine, 410 once failed) — this is how the machine knows the push came from Cloud for its account (the relay does not authenticate the sender of a queued message to the receiver). `POST /talk/:messageId/failed {instanceId, error}` lets the machine refuse one (unknown agent).

**Queue and replay.** Every unconfirmed Talk message has a `talk_undelivered` row (`messageId` unique, `pushedAt`, `attempts`, `deliverBy` = +24 h). Rows are replayed oldest first after a Slack registry heartbeat, after an ingest from that machine, and by a 30 s sweep on each auth node (machines without Slack never heartbeat). Each push first claims the row (conditional update on `pushedAt`), so two nodes never push one row at once. A push the machine has not confirmed after 5 min is repeated (max 6; the machine dedupes on `clientMessageId`). Past `deliverBy` the sweep marks the message `failed` ("Not delivered: <device> was offline for 24 hours" / "did not confirm the message within 24 hours") and drops the row. `delivered` comes from ingest: the machine's upload carries the same `clientMessageId`; ingest rewrites the Talk document with the machine's ids and deletes the row.

**Machine side (OSS:services/cloud/cloud-talk-inbound.service.ts).** Listens on CloudSyncService for `talk_message`, fetches the text (one token refresh on 401, 3 retries on network/5xx), checks `instanceId`/`clientMessageId`/`agentSession` against what Cloud returned, then `recordCloudTalkTurn` into the agent's DM (owner `dev-user-001`, `source: 'cloud-talk'`, the Talk `clientMessageId`; a re-push dedupes to the same row and pages nobody) and hands it on like a portal chat DM (`intakeChatV2OwnerMessage(…, 'portal')` → `ChatV2DispatcherService.dispatchMessage`, which activates a sleeping agent). The reply goes through `reply-chat` into the same DM, takes `source: 'cloud-talk'` from the latest owner row, stays off Slack (G6) and uploads with `agentSession` + the DM channel. Starting the handler turns on the `talk_message` capability.

**Old machines.** `CloudSyncService` emits every relay message; each listener filters on its own `type` and the poll acks it, so an older machine drops an unknown `talk_message` without error. Cloud never sends one to a machine that does not advertise `talk_message` (409 `machine_outdated`); the portal falls back to relay RPC for those (`GET /agents` → `talk: false`).

**Roster.** Both the Slack registry heartbeat and the uploader carry `roster: [{agentSession, displayName, role, teamName}]` (local session names, orchestrator = `crewly-orc`) and `capabilities`. The uploader sends them on an empty batch every 5 min and at once when the capabilities change, which covers machines without Slack. `GET /agents` lists every roster agent (no messages needed), folds the registry's `crewly-orc@<instance>` into `crewly-orc` (P2 listed the orchestrator twice), and adds `talk: boolean`.

**Not done here.** The spec's old-machine fallback where Cloud itself sends a `chat_request sendMessage` to machines without `talk_message` — the portal keeps its relay-RPC path for them instead (409 tells it which).

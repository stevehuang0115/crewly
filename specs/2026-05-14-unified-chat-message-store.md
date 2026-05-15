# Unified Chat Message Store — Single Read/Write Entry Point

**Date:** 2026-05-14
**Status:** Draft
**Owner:** Steve Huang / Crewly OSS

## Context

Today the Crewly backend persists chat messages across **two parallel systems** that have grown side-by-side without explicit handoff:

| Layer | Backing Store | Status | Used by |
|---|---|---|---|
| **Legacy `ChatService`** | `~/.crewly/chat/*.json` (one file per conversation) | Active in production | All runtimes (claude-code, gemini-cli, crewly-agent), all sources (web, Slack) |
| **`ChatV2Service` + `MessageStore`** | `~/.crewly/chat.db` (SQLite, schemas `chat_channels` + `chat_messages`) | Built, schema deployed, 0 rows in production | Reserved for Phase A channel/DM migration |

The 2026-05-14 dogfood investigation also surfaced that the legacy layer has **non-trivial reliability gaps** depending on which runtime / source produced the message:

| Trigger | Path | Reliability |
|---|---|---|
| Web user → Agent (HTTP POST `/chat/messages`) | `chat.controller` → `ChatService.sendMessage` | ✅ Always writes |
| Web Agent → User (PTY runtimes) | PTY stdout → `TerminalGateway.processTerminalOutput` if `[RESPONSE]`/`[NOTIFY]` marker | ⚠️ Marker-dependent |
| Web Agent → User (in-process) | `routeInProcessResponseToChat` → `chatGateway.processNotifyMessage` → `ChatService.addDirectMessage` | ✅ Always writes (since PR #543) |
| Slack user → Agent | `slack.controller.ts:246` → `ChatService.addDirectMessage` | ✅ Always writes |
| Slack Agent → User (via `reply_slack` tool) | `/slack/send` → `ChatService` IF agent included `[CHAT:id]` in reply text | ⚠️ Depends on agent self-tagging |
| Tool-call intermediate output | None | ❌ Not persisted |
| System / progress messages | `ChatService.addSystemMessage` — explicit caller required | ⚠️ Easy to forget |

Symptoms in practice:
- **Agent conversation context leaks across chat threads** (the leak that motivated this spec — in-process runtime's `AgentRunnerService.state.messages[]` is global, not per-thread)
- **PTY runtimes lose user-facing replies** when the agent forgets to wrap output in `[NOTIFY]`
- **Slack auto-routed replies sometimes write with the wrong channel_id** when the agent's reply text doesn't carry `[CHAT:id]`
- **chat.db SQLite layer exists but is unused** — wasted infrastructure investment

## Goal

A **single canonical chat message store** (`chat_messages` table in `chat.db`) with **single canonical write entry** and **single canonical read entry**, used by every runtime and every source.

Specifically:
1. **Single write API**: All chat persistence flows through one service method. No runtime, controller, or gateway writes directly to the storage layer.
2. **Single read API**: All chat consumers (frontend UI, agent context hydration, audit views, V3 SLA cascade, etc.) call the same read method.
3. **Single backing store**: `chat.db` (SQLite). Legacy `~/.crewly/chat/*.json` is retired.
4. **No marker-dependent persistence**: Writes happen at the runtime boundary, not based on `[NOTIFY]`/`[RESPONSE]` scanning of stdout.

## Non-Goals

- Replacing the V3 SLA / Request tracker (separate concern; reads from chat layer).
- Changing the chat UI/UX or WebSocket protocol.
- Adding new chat features (threading, reactions, etc.) — scope is migration only.

## Target Architecture

```
                          ┌─────────────────────────────┐
   Web POST /chat/...     │                             │
   ─────────────────────► │                             │
                          │                             │
   Slack inbound          │                             │
   ─────────────────────► │   ChatV2Service             │
                          │   ────────────              │
   PTY runtime finish     │   ┌─ recordTurn(             │     ┌──────────────┐
   ─────────────────────► │   │    channelId,           │ ────►│              │
                          │   │    senderType,           │     │  chat.db     │
   In-process finish      │   │    content,              │     │  (SQLite)    │
   ─────────────────────► │   │    metadata             │     │              │
                          │   │  )                       │     └──────────────┘
   Slack /reply tool      │   └─ getThreadHistory(...)  │            ▲
   ─────────────────────► │                             │            │
                          │   getMessages, getThread,   │            │
   Agent context hydrate  │   getChannel, …             │ ◄──────────┘
   ─────────────────────► │                             │
                          └─────────────────────────────┘
```

Every arrow above is the **only** path between the box on the left and the store on the right. No bypasses.

### Canonical Write API

```typescript
interface RecordTurnInput {
  channelId: string;              // chat_channels.id
  senderType: 'user' | 'agent' | 'system';
  senderId: string;               // user id OR agent session name OR 'system'
  content: string;                // markdown / text
  contentType?: 'text' | 'markdown' | 'image_ref' | 'system_note';
  threadId?: string;              // optional Slack-style thread root
  mentions?: string[];            // member ids referenced in content
  clientMessageId?: string;       // idempotency key
  metadata?: {
    source?: 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool';
    slackChannelId?: string;
    slackThreadTs?: string;
    runtime?: 'claude-code' | 'gemini-cli' | 'crewly-agent';
    // … other context-specific fields
  };
}

interface RecordTurnResult {
  message: ChatMessage;
  deduped: boolean;               // true if clientMessageId already existed
}

ChatV2Service.recordTurn(input: RecordTurnInput): Promise<RecordTurnResult>;
```

Properties:
- **Idempotent** via `clientMessageId` (already supported by `MessageStore.insert`).
- **Transactional** — single SQLite transaction, no partial state.
- **Source-tagged** — `metadata.source` identifies which writer produced the row; enables audit + future per-source observability.
- **No marker scanning** — the caller is responsible for handing in the user-facing reply text. PTY runtimes that need to extract the reply from a noisy stdout do that work **before** calling `recordTurn`.

### Canonical Read API

```typescript
interface ThreadHistoryQuery {
  channelId: string;
  threadId?: string;
  before?: number;                // pagination cursor (created_at)
  limit?: number;                 // default 50
  senderTypes?: Array<'user' | 'agent' | 'system'>;
}

ChatV2Service.getThreadHistory(query: ThreadHistoryQuery): Promise<ChatMessage[]>;
ChatV2Service.getMessage(id: string): Promise<ChatMessage | null>;
ChatV2Service.listChannels(filter: ChannelFilter): Promise<ChatChannel[]>;
ChatV2Service.getChannel(id: string): Promise<ChatChannel | null>;
```

The frontend, agent context hydrator, audit views, etc. all read through these. No reader inspects `~/.crewly/chat/*.json` after the migration completes.

## Migration Plan

Six phases. Each phase is independently shippable and reversible (until Phase 6).

### Phase 1 — Introduce `ChatV2Service.recordTurn`

- Add the unified write method on top of the existing `MessageStore.insert`.
- Behaviour-preserving: existing HTTP write paths can stay on `MessageStore.insert` directly during Phase 1.
- Add 1:1 tests per CLAUDE.md.
- **Deliverable:** API surface exists; no behaviour change.

### Phase 2 — Migrate in-process runtime to `recordTurn`

- `routeInProcessResponseToChat` switches from `chatGateway.processNotifyMessage` (legacy ChatService) to `ChatV2Service.recordTurn` with `source: 'in-process-runtime'`.
- `routeInProcessResponseToSlack` adds a parallel `recordTurn` call with `source: 'reply-tool'`.
- **Deliverable:** in-process runtime is the first runtime fully on v2.

### Phase 3 — Migrate Slack inbound + `/slack/send` to `recordTurn`

- `slack.controller.ts:246` (inbound) switches.
- `POST /slack/send` switches; channel_id resolution moves into the controller (rely on `slackChannelId`/`slackThreadTs` lookup against `chat_channels`, not on `[CHAT:id]` marker in agent text).
- **Deliverable:** Slack stops relying on agent self-tagging for persistence.

### Phase 4 — Migrate PTY runtimes (claude-code, gemini-cli)

**Discovery (2026-05-14, during Phase 3 implementation):** there is no production write path from raw PTY stdout into the chat layer.

  - `chat.gateway.processTerminalOutput` (the `[RESPONSE]` / `[CHAT_RESPONSE]` regex extractor) has zero external callers — `grep -r processTerminalOutput backend/src --include="*.ts"` returns only the definition site. Effectively dead code.
  - `chat.gateway.processNotifyMessage` is called exclusively from the in-process runtime (`routeInProcessResponseToChat`), which Phase 2 already migrated to also call `recordTurn` directly.
  - PTY runtimes (claude-code, gemini-cli) emit their user-facing replies by invoking the `reply-slack` (or equivalent) tool, which POSTs to `/slack/send`. That outbound path is covered by Phase 3.

**Conclusion:** No Phase 4 code changes required. The "boundary detection" sub-problem the spec originally anticipated does not exist in the current architecture — PTY agents reach the chat layer through tool calls, not stdout scraping.

**Open follow-up (out of scope for this PR series):** if a future runtime emits user-facing replies as raw PTY stdout (no tool call), we'd need to introduce stream-json boundary detection at that point. Defer until a real consumer materializes.

- **Deliverable:** This phase becomes a no-op; the spec text is left in place as a marker that the work was considered and declined with cause.

### Phase 5 — Data migration

- One-time script: read every `~/.crewly/chat/*.json`, transform to `chat_channels` + `chat_messages` rows, write via `MessageStore.insert` with synthetic `clientMessageId` to preserve idempotency.
- Idempotent — safe to re-run.
- Backup the JSON directory before truncating.
- **Deliverable:** SQLite contains the full historical conversation set.

### Phase 6 — Retire legacy `ChatService`

Phase 6 has to be staged carefully because legacy `ChatService` is still
the read source for the frontend chat UI today. Cutting writes before
cutting reads would silently break the UI. The ordering is:

**Phase 6a — Reader migration (one PR per reader, can land independently):**
  - `chat.controller.ts` HTTP read endpoints (`GET /chat/messages`,
    `GET /chat/conversations`, etc.) — point at `ChatV2Service.listMessages`
    / `listChannels`.
  - `chat.gateway.ts` WebSocket subscriber paths — emit chat-v2 events.
  - V3 SLA subscribers and any audit tooling that reads
    `chat_messages` indirectly.

  Each reader migration must verify the frontend renders identically
  against the migrated endpoint before merging. Phase 5b (the
  migration script) must have run in production first so chat-v2
  contains the full historical conversation set.

**Phase 6b — Stop legacy writes:**
  - Remove the legacy `chatService.*` write calls left in place by
    Phases 2–3 (their dual-write companions remain).
  - Remove `processNotifyMessage` from `chat.gateway.ts` (now
    redundant with the in-process `recordTurn` direct call).
  - Remove `routeInProcessResponseToChat`'s legacy branch.
  - Verify the JSON store at `~/.crewly/chat/` stops growing.

**Phase 6c — Delete legacy code + data:**
  - Delete `backend/src/services/chat/chat.service.ts` and its tests.
  - Delete `~/.crewly/chat/` directory (post-backup, per CLAUDE.md
    no-destructive-action policy).
  - Remove the dead `agent_already_bound` 409 branch in
    `channel.store.ts` (became unreachable after Phase 2 dropped the
    unique index; this is the natural cleanup window).
  - Delete every `import ... from '../chat/chat.service'` line.

**Success criteria for the entire spec are met when Phase 6c completes.**

### Phase 6 scope refinement (2026-05-14, discovered during impl)

Surveying call sites for Phase 6a showed the legacy `ChatService` surface is **substantially larger** than the original spec assumed:

- `backend/src/controllers/chat/chat.controller.ts` — 14 separate `getChatService()` call sites covering messages, conversations, conversation-by-id, current-conversation, statistics, pending-Slack-delivery scan, message metadata updates, archiving, etc.
- `backend/src/websocket/chat.gateway.ts` — tight integration via event listeners (`chat_message`, `chat_typing`, `conversation_updated`) and the `processNotifyMessage` / `processTerminalOutput` PTY hooks.
- `backend/src/index.ts:1469` — bootstrap path reads `chatService.countAllMessages()` for telemetry.
- `backend/src/services/slack/notify-reconciliation.service.ts` — `getMessagesWithPendingSlackDelivery` + `updateMessageMetadata` (Slack delivery state machine).

`ChatV2Service` is missing equivalents for several of these:
  - `getCurrentConversation()` — legacy semantic of "the single active conversation" doesn't map to chat-v2's multi-channel model.
  - `getMessagesWithPendingSlackDelivery(maxAgeMs)` — Slack-delivery reconciliation scan.
  - `updateMessageMetadata(conversationId, messageId, patch)` — mutation of stored message metadata.
  - `emitTypingIndicator(...)` — WebSocket-side ephemeral event (no storage write).
  - `getStatistics()` — aggregate counts grouped by conversation.

Phase 6 must therefore be expanded to include **API gap-filling on ChatV2Service** before the reader migration can proceed:

**Phase 6.0 — chat-v2 API gap fill (precondition for 6a):**

Sub-phase **6.0a (done in this PR, commit d2a9e967):**
  - `ChatV2Service.findMessagesWithPendingSlackDelivery(maxAgeMs)` using the `metadata->>'$.slackDeliveryStatus'` JSON predicate.
  - `ChatV2Service.updateMessageMetadata(messageId, patch)` (in-place merge into `chat_messages.metadata` via `json_patch`).
  - `ChatV2Service.getStatistics()` returning aggregate counts.

Sub-phase **6.0b (still TODO — own PR):** the broader survey of `chat.controller.ts` found 7 additional missing methods that block Phase 6a:
  - `createNewConversation(title)` — `chat-v2.createChannel` requires `agentSession` + principal, but the legacy method just creates an unbound channel for the current user. Need a thinner factory or to update controllers to pass agentSession explicitly (per-route decision).
  - `updateConversationTitle(id, title)` — chat-v2 has no rename method. Add `renameChannel(channelId, name, principal)`.
  - `archiveConversation(id)` — already has `archiveChannel`; map.
  - `unarchiveConversation(id)` — add `unarchiveChannel`.
  - `deleteConversation(id)` — chat-v2 only archives. Decide: hard delete or alias to archive? Likely add `deleteChannel(channelId, principal)` with hard-delete semantics; archive remains the soft-delete path.
  - `clearConversation(id)` — delete all messages but keep channel. Add `clearChannel(channelId, principal)`.
  - `getMessageCount(filter)` — partial of `getStatistics`; promote to a per-channel `countMessages(channelId)`.
  - `getCurrentConversation()` — semantically deprecated; frontend should adopt "latest channel for this owner" by reading from `listChannels({principal, sort: 'last_message_at_desc', limit: 1})`. Phase 6a controllers can call that directly.

  Estimated: 1 PR, ~250 LOC + tests.

**Phase 6a-c then proceeds as originally written.**

This expansion does not change the destination (single store + single entry); it just acknowledges the migration runway is longer than the initial spec anticipated.

## Dependent Work Enabled by This Spec

Once the unified store lands, several blocked items become feasible:

1. **Per-thread agent context** (`AgentRunnerService.state.messages[]` → `Map<channelId, ConversationState>`):
   Hydrate per-channel history from `ChatV2Service.getThreadHistory({channelId})` on first access. The 2026-05-14 leak is fixed structurally rather than by careful self-tagging.

2. **Restart-safe agent conversation memory**: in-process runtime's conversation history survives backend restart because it hydrates from the canonical store.

3. **Audit / replay**: any consumer can rebuild a thread's exact history from one query, including the `source` tag for forensics ("did this reply come from PTY or in-process?").

4. **Cross-runtime parity**: switching `crewly-orc` between claude-code and crewly-agent runtimes preserves continuity because both runtimes read/write the same store.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Data loss during Phase 5 migration | High | Back up `~/.crewly/chat/` before migration; migration script is idempotent; verify row counts match file count before deleting the backup. |
| Behavioural regression in PTY boundary detection (Phase 4) | High | Keep `[NOTIFY]` fallback in place during Phase 4; ship stream-json path behind a feature flag; A/B compare written rows before flipping the default. |
| Performance regression from JSON-file → SQLite at high write rate | Medium | `MessageStore.insert` is already used by chat-v2; baseline benchmarks show single-row inserts under 5ms. Run load test before Phase 6. |
| Frontend reader regression | Medium | Reader migration in a parallel Phase 4.5; keep legacy read endpoints serving from SQLite for one release cycle. |
| `clientMessageId` collisions during data migration | Low | Migration synthesizes deterministic IDs from `conversationId + seq`; collisions caught by `MessageStore`'s existing unique index. |

## Success Criteria

The goal is achieved when **all** of these hold:

1. `grep -r "ChatService" backend/src` returns zero non-test, non-deprecated-shim hits.
2. `grep -rE "addDirectMessage|addAgentMessage|addSystemMessage|processNotifyMessage"` returns zero hits in production code paths.
3. `~/.crewly/chat/` directory is absent (or empty, with `.gitignore`).
4. Every runtime × source combination from the gap matrix in the Context section now flows through `ChatV2Service.recordTurn`.
5. Frontend chat UI continues to render conversations identically (regression test passes).
6. Per-thread agent context isolation (the original motivating bug) is provable by integration test: two conversations in flight, neither's `messages[]` contains the other's turns.
7. The phrase "depends on the agent including `[CHAT:id]` in the reply text" no longer appears in any code comment or doc.

## Open Questions

1. **Tool-call intermediate output**: should `tool_call` events be persisted as their own `chat_messages` rows (with `sender_type='system'`, `contentType='system_note'`)? Or kept ephemeral? Decision deferred to Phase 4 design review.
2. **Multi-process safety**: when OSS + Pro both run and both can talk to the same backend, can they both write through `recordTurn` concurrently? `MessageStore.insert` uses a transaction with `seq = MAX(seq)+1` — verify behaviour under concurrent inserts.
3. **PTY stream-json mode**: confirmed Claude Code supports it. Need to confirm Gemini CLI's equivalent before committing Phase 4 to a non-marker strategy.

## Phase 2 design discovery — channel-id semantic mismatch (2026-05-14)

Working through the Phase 2 implementation surfaced a real architectural friction that must be resolved before any writer migration can proceed.

**The mismatch:**

- **Legacy `ChatService` semantics**: a "conversation" is one Slack thread or one web chat thread. A single agent (e.g., `crewly-orc`) participates in MANY conversations concurrently — one per Slack DM thread, one per web chat session, etc.
- **`chat-v2` schema (current)**: `chat_channels` has a partial unique index `uq_channel_agent_dm_active ON (agent_session) WHERE archived_at IS NULL AND type = 'dm'`. This enforces **one active DM channel per agent**. Trying to insert a second DM channel for the same agent throws `agent_already_bound` (409).

If we naively map every legacy conversationId to a chat_channels row of type='dm', the second Slack thread to `crewly-orc` will be rejected at insert time. The current chat-v2 design assumed Phase 1 1:1 user↔agent DMs, not the many-thread reality of the production system.

**Options:**

1. **A. Treat each legacy conversation as `type='channel'`** instead of `'dm'`.
   - Pros: The unique index doesn't apply to `'channel'` rows; we can have N concurrent threads per agent.
   - Cons: `'channel'` rows require `team_id` per the schema check, and the type was introduced for the Slack-like team surface. Stretching it to cover ephemeral Slack DM threads muddles the type's meaning.

2. **B. Drop or relax the unique index** so DM channels can also be N-per-agent.
   - Pros: Cleanest mapping — legacy conversationId becomes `chat_channels.id` 1:1.
   - Cons: Breaks the existing chat-v2 Phase A contract (which guaranteed 1:1 binding for UX reasons). Frontend code that lists "active DM for agent X" would need to handle multiple results.

3. **C. One chat-v2 channel per agent, legacy conversationIds become `thread_id`** within that channel.
   - Pros: Preserves chat-v2's 1:1 invariant; reuses the existing `thread_id` column on `chat_messages`.
   - Cons: Frontend read code must group messages by `thread_id` to render "conversations". `chat_channels.last_message_at` and presence semantics conflate across all threads. A high-volume agent has all history in one channel, complicating pagination.

4. **D. Add a new abstraction layer**: chat-v2 "channel" stays as the agent-level container; introduce a new `chat_conversations` table that maps `(channel_id, conversation_key)` → conversation metadata. `chat_messages` gains a `conversation_id` FK.
   - Pros: Cleanest separation of concerns; no overloading of existing fields.
   - Cons: Schema migration, more tables, more work. Pushes Phase 1 milestone further.

**Decision (2026-05-14, user-approved): Option B — drop the 1:1 unique index.**

The user's mental model: "one agent participates in many threads, like an employee in many Slack channels". This matches legacy `ChatService` semantics exactly — each Slack thread or web chat session is its own conversation; an agent has N concurrent conversations.

The chat-v2 Phase A `uq_channel_agent_dm_active` index was a UX-driven constraint from the assumption that a user would have ONE persistent DM channel with each agent. That assumption doesn't hold once Slack thread inbound is the primary surface (and never held for ephemeral web chat sessions either).

**Resolution:**
- `chat_channels.id = legacy_conversation_id` (e.g. `slack-D0AC7-1234`, `web-conv-abc`) — direct 1:1 mapping, no synthetic IDs
- `chat_channels.type = 'dm'` for both Slack threads and web chat (both model an agent↔user conversation)
- `chat_channels.agent_session = agentSession` (multiple rows per agent — that's the whole point)
- `chat_channels.owner_user_id = 'system'` for server-internal creation paths; real user id when known via auth
- **Drop** `uq_channel_agent_dm_active` partial index
- Update `chat-db.test.ts` to assert the index is absent (was: assert it enforces)

**New helper (Phase 2):**
```typescript
ChatV2Service.ensureChannelForLegacyConversation(args: {
  conversationId: string;       // legacy id used as the channel.id
  agentSession: string;
  name?: string;                // display name; defaults to conversationId
  ownerUserId?: string;         // defaults to 'system'
}): ChatChannelDTO;             // existing channel if present, freshly-created otherwise
```

Idempotent. Phase 2 callers (in-process runtime) invoke it before each `recordTurn`.

**Impact on phases:**
- Phase 1 (this PR) is unaffected — `recordTurn` already works against an existing channel.
- Phase 2 adds the helper + drops the index + dual-writes from `routeInProcessResponseToChat`.
- Phase 3 (Slack) and Phase 4 (PTY) reuse the same helper.
- Phase 5 data migration: each `~/.crewly/chat/*.json` becomes one `chat_channels` row (id = filename without `.json`) plus N `chat_messages` rows.

## Implementation Tracking

Each phase ships as a separate PR with the conventional commits prefix and a reference back to this spec:

```
feat(chat-v2): add recordTurn canonical write API (spec: unified-chat-message-store Phase 1)
refactor(agent-runtime): route in-process replies through chat-v2.recordTurn (Phase 2)
refactor(slack): migrate Slack inbound and /slack/send to chat-v2.recordTurn (Phase 3)
refactor(terminal): migrate PTY runtimes to chat-v2.recordTurn (Phase 4)
chore(chat-v2): one-time legacy-JSON → SQLite migration (Phase 5)
chore(chat-v1): retire legacy ChatService (Phase 6)
```

Test coverage requirement per phase: every new or modified source file has a co-located `.test.ts` per CLAUDE.md, and the integration test verifying success criterion #6 lands no later than Phase 4.

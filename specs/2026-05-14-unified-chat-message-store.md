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

- `TerminalGateway` adds a finalizer hook that fires on each "agent turn complete" boundary. The hook calls `recordTurn(source: 'pty-runtime', runtime: ...)`.
- **Boundary detection** is the hard sub-problem. Initial strategy:
  - Claude Code: use Claude Code's stream-json mode (stdout JSON events with explicit turn boundaries) instead of raw PTY scraping. Falls back to `[NOTIFY]` marker if stream-json is unavailable.
  - Gemini CLI: similar approach if available; otherwise retain marker dependency with explicit documentation.
- **Deliverable:** PTY runtimes write via the canonical API; `[NOTIFY]` becomes a deprecated fallback rather than the primary mechanism.

### Phase 5 — Data migration

- One-time script: read every `~/.crewly/chat/*.json`, transform to `chat_channels` + `chat_messages` rows, write via `MessageStore.insert` with synthetic `clientMessageId` to preserve idempotency.
- Idempotent — safe to re-run.
- Backup the JSON directory before truncating.
- **Deliverable:** SQLite contains the full historical conversation set.

### Phase 6 — Retire legacy `ChatService`

- Delete `backend/src/services/chat/chat.service.ts` and its tests.
- Delete `~/.crewly/chat/` directory (post-backup).
- Remove `addDirectMessage` / `addAgentMessage` / `addSystemMessage` from all call sites (should be zero remaining after Phases 2–4).
- Frontend reads through new `getThreadHistory` API.
- **Deliverable:** Single source of truth. Goal achieved.

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

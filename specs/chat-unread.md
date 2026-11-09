# Chat unread: server-side, per message, synced across clients

Status: phase 1 (issue #1400). Phase 2 (private channels, voice messages) is out of scope here.

## Goal

Unread is the **owner's own state**, kept on the server so the OSS `/team-chat`, the Cloud web portal and the phone
(which read the same chat-v2 store on this machine, web and phone through the relay adapter) always agree.

- Opening a conversation marks it read.
- The owner can mark a message **unread** to keep it for a later follow-up, even after replying (Slack semantics).
- It covers plain agent messages (questions, updates), not only decision cards.

It replaces the per-browser `localStorage` record (`crewly.chat.seen`), which could not be shared between clients and
could not express "this message, not the whole conversation".

## Data model

Table `chat_read_state` in the chat-v2 SQLite database:

```sql
CREATE TABLE chat_read_state (
  channel_id    TEXT PRIMARY KEY,
  last_read_seq INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
```

- Every message with `seq <= last_read_seq` counts as read. `seq` is the per-channel monotonic sequence of
  `chat_messages`.
- A channel with no row has `last_read_seq = 0`.
- **Seed (one time).** The migration runs when the table does not exist yet and inserts one row per existing channel at
  its current max `seq`, so nothing floods as unread on upgrade. It must not run again on later boots, otherwise a
  channel the owner marked unread would silently become read after a restart. The row is removed when a channel is
  hard-deleted (the table has no foreign key; its DDL is a fixed contract).

### Unread count

Messages of the channel with `sender_type != 'user'`, `content_type != 'system_note'` and `seq > last_read_seq`.
Thread replies are included. The owner's own messages and system notes never count.

## Semantics

| Action | Marker |
|---|---|
| `read` with `seq` | `max(current, min(seq, channel max seq))` (forward-only; `seq` past the last message is clamped so a stale or bogus value cannot hide later messages) |
| `read` without `seq` | `max(current, channel max seq)` |
| `unread` with `seq` | `seq - 1` (may move backward; `seq >= 1`) |
| Owner sends a message | `max(current, that message's seq)` |

The owner-send rule applies to messages persisted as the owner (`sendMessage` as the owner, and `recordTurn` with
`senderType: 'user'`, e.g. an owner message arriving from Slack). A message an agent writes into a channel as the owner
(`agentAuthoredAsUser`) does not advance the marker.

## API

All responses use the usual chat-v2 envelope `{ success: true, data }`.

- `ChatChannelDTO` gains `lastReadSeq: number` and `unreadCount: number`, returned by `GET /api/chat/channels` and
  `GET /api/chat/channels/:id`.
- `POST /api/chat/channels/:id/read`, body `{ seq?: number }` -> `{ channelId, lastReadSeq, unreadCount }`.
- `POST /api/chat/channels/:id/unread`, body `{ seq: number }` -> same shape. 400 `validation_error` on a missing or
  invalid `seq`.
- `GET /api/chat/unread` -> `{ total, channels: [{ channelId, lastReadSeq, unreadCount }] }`, only channels with
  `unreadCount > 0`, over the channels the owner sees in the conversation list (own + bridged Slack, not archived).

### Live updates

WebSocket frame on every change (read, unread, and when a new message raises a count):

```json
{ "type": "read_state", "payload": { "channelId": "...", "lastReadSeq": 12, "unreadCount": 3 } }
```

`ChatV2Service` emits `read_state`; the server wiring broadcasts it through `ChatV2Gateway.broadcast`, which also feeds
the relay adapter's `onBroadcast`, so Cloud portal and phone receive the same frame as a `chat_event`
(`{ channelId, event }`), exactly like message events.

The gateway fans a frame out to subscribers of that channel only (one socket per open channel). A client that wants
counts for channels it has not opened refreshes `GET /api/chat/unread` (or the channel list) on an interval; the OSS
page polls every 30 s and the nav badge refetches immediately after the page changes read state.

### Relay RPCs (`ChatV2RelayAdapter`)

`markChannelRead { channelId, seq? }`, `markChannelUnread { channelId, seq }`, `getUnread {}`, with the same return
shapes as the REST bodies' `data`. `CHAT_RPC_METHODS` and `ChatRpcMethod` list them.

## Frontend (`/team-chat`)

- `@crewly/chat-ui`: `Channel` gains optional `lastReadSeq` / `unreadCount`; `ChatWebsocketEvent` gains `read_state`;
  `ChatApiClient` gains optional `markChannelRead`, `markChannelUnread`, `getUnread` (optional so transports that do not
  implement them yet keep working); `useMessages` / `useMergedMessages` take `{ onReadState }`; `MessageThread` takes
  `onMarkUnread` (a "Mark unread" item in the per-message "⋯" menu of the quiet variant) and positions the
  `unreadAfterSeq` divider at the first message past the marker even when the marker's own message is not in the list
  (paged off-screen, or a hidden thread reply).
- `useChatReadState` (page behaviour): per-conversation counts from the list plus live frames (a frame beats the list
  until the next list refresh); opening a conversation marks it read and keeps marking while new messages arrive; the
  "Unread" divider sits at the marker as it was when the conversation was opened, so the owner still sees what was new;
  "Mark unread" moves the marker and the divider and stops auto-reading until the owner leaves and reopens the
  conversation.
- The orchestrator conversation merges its own channel with Slack thread channels. Its count is the sum over those
  channels and opening it marks all of them read. Sequence numbers of different channels are not comparable, so a merged
  feed draws no divider; "Mark unread" still works per message (it uses the message's own channel).
- The nav badge (`useChatUnreadCount`) shows `GET /api/chat/unread`'s `total` (unread messages, no longer unread
  conversations). `localStorage` `crewly.chat.seen` is no longer read or written.

## Not in phase 1

- A cross-channel realtime feed (counts of unopened channels update by polling, not by frame).
- Unread for non-owner users: the marker is the owner's (the single-owner OSS model).
- Per-message "unread" styling beyond the divider and the conversation count.

## Tests

- Store: seed migration (once only), forward-only read, backward unread, counts exclude owner messages and system notes,
  thread replies count, grouped `listUnread`, hard-delete cleanup.
- Service: DTO fields, owner send advances the marker (and a later mark-unread still works), `read_state` emitted on
  read / unread / agent message, authorization, seq validation, `getUnreadSummary`.
- Routes and relay adapter RPCs; gateway `read_state` frame; `read_state` forwarded to Portal as a `chat_event`.
- chat-ui: DTO / WS translation, client methods, `useMessages` `onReadState`, `MessageThread` divider placement and
  "Mark unread".
- Frontend: `useChatReadState`, `useChatUnreadCount`, conversation list count, `LiveTeamChatPage` end to end.

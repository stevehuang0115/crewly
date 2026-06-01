/**
 * Core type definitions for @crewly/chat-ui.
 *
 * These types describe the Chat API surface shared between this package
 * and any backend implementation (Crewly OSS today, Cloud Pro tomorrow).
 *
 * Wire-format DTOs live in `api/dto.ts`; the types in this file are the
 * domain shapes hooks and components consume.
 *
 * @module types/chat
 */

// =============================================================================
// Presence
// =============================================================================

/**
 * Liveness state for a bound agent on a channel.
 *
 * - `online`  — agent session is registered and idle/working
 * - `busy`    — agent is mid-task (visible but slower to reply)
 * - `offline` — agent session is not active; messages will queue
 */
export type AgentPresenceStatus = 'online' | 'busy' | 'offline';

/**
 * Snapshot of a single agent's presence.
 */
export interface AgentPresence {
  agentId: string;
  status: AgentPresenceStatus;
  /** ISO 8601 timestamp of last heartbeat the server saw from this agent. */
  lastSeen?: string;
}

// =============================================================================
// Channels
// =============================================================================

/**
 * Channel kind — Phase B/C addition (SEALED design 2026-04-25 §3.1).
 *
 * - `dm`      — 1:1 user↔agent direct-message channel. Default for legacy
 *               and Phase 1 callers; `agentSession` is the binding key.
 * - `channel` — public team-scoped channel (`#general`, `#proj-<name>`).
 *               Multiple agents may participate; `agentSession` is empty
 *               on the wire and `teamId` is required.
 */
export type ChannelType = 'dm' | 'channel' | 'huddle';

/**
 * A chat channel — either a 1:1 user↔agent DM or a team-scoped channel.
 *
 * Phase 1 contract (single agent per DM) is preserved for `type='dm'`.
 * Phase B (SEALED §3.1) adds `type='channel'` for Slack-like team
 * surfaces; those rows have an empty `agentSession` and a populated
 * `teamId`.
 */
export interface Channel {
  id: string;
  /**
   * Session name of the bound Crewly agent for `type='dm'` rows. Empty
   * string for `type='channel'` rows (no 1:1 binding).
   */
  agentSession: string;
  /** Human-readable channel name — agent display name for DMs, `#name` for channels. */
  name: string;
  /** Optional purpose/description shown under the channel name. */
  purpose?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent message; used for sort order. */
  lastMessageAt?: string;
  /** Denormalized presence for fast sidebar rendering. */
  presence?: AgentPresenceStatus;
  /**
   * Phase B (SEALED §3.1) — channel kind. Required field on the wire from
   * Phase B onward; legacy callers / mock seeds default to `'dm'` so
   * existing callsites keep compiling without explicit migration.
   */
  type?: ChannelType;
  /** Phase B — team workspace ID. Required when `type='channel'`. */
  teamId?: string;
  /** Phase B — project link. Optional even when `type='channel'`. */
  projectId?: string;
  /**
   * Phase B — for `type='dm'`, the target member's id (distinct from
   * `agentSession` which is the wire-level binding). For `type='channel'`
   * rows, always undefined.
   */
  targetMemberId?: string;
}

/** Body for `POST /api/chat/channels`. */
export interface CreateChannelInput {
  /** Required when `type='dm'`; ignored when `type='channel'`. */
  agentSession?: string;
  name: string;
  purpose?: string;
  /** Phase B (SEALED §3.1). Defaults to `'dm'` when omitted. */
  type?: ChannelType;
  /** Phase B — required when `type='channel'`. */
  teamId?: string;
  /** Phase B — optional even when `type='channel'`. */
  projectId?: string;
  /** Phase B — optional for `type='dm'`. */
  targetMemberId?: string;
}

/**
 * Body for `POST /api/chat/channels/huddle` — create an ad-hoc multi-agent
 * group chat ("拉群"). Messages posted to the resulting `type='huddle'`
 * channel fan out to every member agent.
 */
export interface CreateHuddleInput {
  /** Display name for the group (e.g. "Launch crew"). */
  name: string;
  /** Optional one-line purpose. */
  purpose?: string;
  /** Agent session names to pull into the group. Must be non-empty. */
  memberSessions: string[];
}

// =============================================================================
// Messages
// =============================================================================

/**
 * Who authored a chat message.
 *
 * Phase 1 keeps this intentionally narrow — no multi-user channels, no
 * bot/system distinctions beyond user vs agent.
 */
export type MessageAuthorRole = 'user' | 'agent' | 'system';

/**
 * Attachment types permitted in Phase 1 (images only).
 */
export interface MessageAttachment {
  id: string;
  kind: 'image';
  /** Relative or absolute URL the consumer can render in an `<img>`. */
  url: string;
  /** Original filename if known. */
  filename?: string;
  /** Bytes, optional hint for UI. */
  size?: number;
  /** MIME type (e.g. `image/png`). */
  mimeType?: string;
}

/**
 * Optimistic-send delivery status. The client decorates messages it has
 * just sent so the timeline can render a pending bubble before the server
 * confirms persistence.
 *
 * - `pending` — sent locally, no HTTP 201 yet
 * - `sent`    — server has persisted the message (HTTP 201 or WS replay)
 * - `failed`  — HTTP send failed; user can retry
 */
export type MessageDeliveryStatus = 'pending' | 'sent' | 'failed';

/**
 * A single message in a channel timeline.
 */
export interface Message {
  id: string;
  channelId: string;
  /**
   * Monotonic per-channel sequence assigned by the server. Optimistic
   * pending messages carry `seq: -1` until reconciled with the server
   * record.
   */
  seq: number;
  author: {
    role: MessageAuthorRole;
    /** Agent session id or user id depending on role. */
    id: string;
    /** Human-readable display name. */
    name?: string;
  };
  /** Markdown-rendered content. */
  content: string;
  attachments?: MessageAttachment[];
  /** ISO 8601 timestamp. */
  createdAt: string;
  /**
   * Server-echoed idempotency token from `metadata.clientMessageId`.
   * Used to reconcile optimistic pending records with the persisted row.
   */
  clientMessageId?: string;
  /** Optimistic client-side status for messages not yet ack'd by server. */
  deliveryStatus?: MessageDeliveryStatus;
  /**
   * Phase B (SEALED §3.2) — array of mention IDs (member or team ids)
   * referenced inline in `content`. Empty array on the wire when no
   * mentions; never null. The composer parses chips into this list
   * before send.
   */
  mentions: string[];
  /**
   * Phase B (SEALED §3.2) — Slack-style thread root id. When set, this
   * message is a reply within the thread rooted at `threadId`; consumers
   * group by `threadId` to render the thread sub-pane.
   */
  threadId?: string;
  /**
   * Slack-style threading — number of replies in this message's thread.
   * Server-computed and present only on root messages (those with no
   * `threadId`) that have at least one reply. Undefined otherwise.
   */
  replyCount?: number;
  /**
   * Slack-style threading — ISO 8601 timestamp of the most recent reply
   * in this message's thread. Paired with `replyCount`.
   */
  lastReplyAt?: string;
}

/** Body for `POST /api/chat/channels/:id/messages`. */
export interface SendMessageInput {
  content: string;
  attachments?: MessageAttachment[];
  /**
   * Optional idempotency token. The server dedupes repeat POSTs bearing the
   * same `clientMessageId` and returns the previously-persisted row — so
   * safe to retry on network failure without double-sending. Generated
   * automatically by the HTTP client when the caller does not supply one.
   */
  clientMessageId?: string;
  /**
   * Phase B (SEALED §3.2) — mention IDs (member or team) referenced
   * inline in `content`. The composer parses chips into this shape
   * before send. Empty array or omitted = no mentions.
   */
  mentions?: string[];
  /**
   * Phase B (SEALED §3.2) — Slack-style thread reply root. When set,
   * the new message is a reply within the thread. Omit for top-level
   * channel messages.
   */
  threadId?: string;
}

/** Shape returned by `GET /api/chat/channels/:id/messages`. */
export interface MessagePage {
  messages: Message[];
  /**
   * Opaque cursor the caller passes back as `?cursor=...` to fetch the next
   * page of older messages. `null` when the start of history has been
   * reached.
   */
  nextCursor: string | null;
}

// =============================================================================
// WebSocket events (domain shape)
// =============================================================================

/**
 * Discriminated union of events the consumer of `subscribeToChannel`
 * receives. Wire frames are translated to this shape inside the API
 * client; hooks never see the raw DTO envelope.
 *
 * Per Sam's tech spec §6 (locked 2026-04-24):
 *
 * - `message`  — new chat message (user or agent). Includes the
 *                domain-translated `Message`. Optimistic pending records
 *                emitted by the local client before HTTP 201 land here too.
 * - `presence` — agent liveness flip on the bound channel.
 * - `pong`     — JSON heartbeat reply from the server. Consumers do not
 *                normally observe this; it is surfaced for tests + custom
 *                liveness UIs.
 * - `error`    — auth, rate-limit, or other server-side fatal. The client
 *                closes the socket after emitting this.
 */
export type ChatWebsocketEvent =
  | { type: 'message'; channelId: string; message: Message }
  | { type: 'presence'; agentSession: string; status: AgentPresenceStatus; lastSeen?: string }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code: string; message: string };

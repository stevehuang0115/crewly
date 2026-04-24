/**
 * Core type definitions for @crewly/chat-ui.
 *
 * These types describe the Chat API surface from Decisions doc (2026-04-24).
 * They are the contract shared between this package and any backend
 * implementation (Crewly OSS today, Cloud Pro tomorrow).
 *
 * NOTE: These types are stable enough to start UI work against. Sam's
 * detailed tech spec may tighten them (e.g. cursor format, attachment
 * shape); when that happens we update here and bump the package minor.
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
 * A chat channel is a 1:1 binding between a user and a Crewly agent session.
 *
 * Phase 1 rule: exactly one agent per channel, and an agent is bound to at
 * most one channel at a time (Decisions doc #3).
 */
export interface Channel {
  id: string;
  /** Session name of the bound Crewly agent (e.g. `crewly-product-max-xxxx`). */
  agentSession: string;
  /** Human-readable channel name — typically the agent's display name. */
  name: string;
  /** Optional purpose/description shown under the channel name. */
  purpose?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent message; used for sort order. */
  lastMessageAt?: string;
  /** Denormalized presence for fast sidebar rendering. */
  presence?: AgentPresenceStatus;
}

/** Body for `POST /api/chat/channels`. */
export interface CreateChannelInput {
  agentSession: string;
  name: string;
  purpose?: string;
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
 * Attachment types permitted in Phase 1 (images only per Decisions doc #5).
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
 * A single message in a channel timeline.
 */
export interface Message {
  id: string;
  channelId: string;
  /** Monotonic per-channel sequence assigned by the server. */
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
  /** Optimistic client-side status for messages not yet ack'd by server. */
  deliveryStatus?: 'pending' | 'sent' | 'failed';
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
// WebSocket events
// =============================================================================

/**
 * Discriminated union of events the server can push on `/ws/chat`.
 *
 * We keep the shape narrow so the consumer doesn't need to guard against
 * unknown event kinds in Phase 1.
 */
export type ChatWebsocketEvent =
  | { type: 'message'; payload: Message }
  | { type: 'presence'; payload: AgentPresence }
  | { type: 'ack'; payload: { clientMessageId: string; serverMessage: Message } };

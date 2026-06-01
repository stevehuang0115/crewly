/**
 * Chat V2 — Internal types and wire-format DTOs.
 *
 * The shapes here back the Chat MVP Phase 1 spec
 * (`.crewly/specs/chat-mvp-phase1-tech-spec-2026-04-24.md` §21).
 * They are deliberately isolated from the existing `types/chat.types.ts`,
 * which belongs to the legacy orchestrator chat pipe.
 *
 * @module services/chat-v2/types
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Who authored a message. Server-assigned; never accepted from request body. */
export type ChatSenderType = 'user' | 'agent' | 'system';

/** What kind of content a message carries. */
export type ChatContentType = 'text' | 'markdown' | 'image_ref' | 'system_note';

/** Agent presence snapshot categories. */
export type ChatAgentPresenceStatus = 'online' | 'busy' | 'offline' | 'starting';

/**
 * Channel type — Phase B Slack-like team-chat addition (SEALED design 2026-04-25 §3.1).
 *
 *  - `dm`: 1:1 user↔agent direct message channel. Matches the Phase 1 / Week 2
 *     contract; existing rows default to this. `agent_session` field is the
 *     1:1 binding key.
 *  - `channel`: public team-scoped channel (`#general`, `#proj-<name>`, etc.)
 *     where multiple agents may participate. The `agent_session` field on
 *     channel-typed rows is left empty (no 1:1 binding).
 *
 * The wire-protocol vocabulary intentionally stays narrow at BE; FE adds
 * `idle` / `inactive` UI states via `@crewly/chat-ui`'s `ChatPresenceStatus`
 * union (the translation lives at the boundary, not here).
 */
/**
 * Channel kind discriminator.
 *
 * - `'dm'`: legacy 1:1 user↔agent surface. `agent_session` is the wire
 *   binding; `team_id` is null.
 * - `'channel'`: Slack-like team-scoped surface. `team_id` is required;
 *   membership is implicitly "everyone in the team".
 * - `'huddle'` (Phase B-2 / 2026-05-17): ad-hoc multi-agent group.
 *   Members are NOT derived from a team — they're stored explicitly in
 *   `chat_channel_members`. Dispatcher fans the user's message out to
 *   every member; agents decide whether to respond, but a member named
 *   in `mentions[]` is told it MUST respond. See
 *   `chat-v2.dispatcher.service.ts` for the prompt construction.
 */
export type ChatChannelType = 'dm' | 'channel' | 'huddle';

/** Mention target kind — Phase B addition (SEALED design §7.1 chip pattern). */
export type ChatMentionKind = 'team' | 'agent';

/** Enum values exposed as readonly tuples for runtime validation. */
export const CHAT_SENDER_TYPES: readonly ChatSenderType[] = ['user', 'agent', 'system'];
export const CHAT_CONTENT_TYPES: readonly ChatContentType[] = [
  'text',
  'markdown',
  'image_ref',
  'system_note',
];

/** Phase B — channel-type tuple for runtime validation in CreateChannelInput. */
export const CHAT_CHANNEL_TYPES: readonly ChatChannelType[] = ['dm', 'channel', 'huddle'];

/** Phase B — mention-kind tuple for runtime validation in mention parsing. */
export const CHAT_MENTION_KINDS: readonly ChatMentionKind[] = ['team', 'agent'];

// ---------------------------------------------------------------------------
// DB row shapes (1:1 with DDL in sqlite/chat-db.ts)
// ---------------------------------------------------------------------------

/** Row shape of `chat_channels`. Timestamps are ms-since-epoch UTC. */
export interface ChatChannelRow {
  id: string;
  /**
   * 1:1 binding to the agent's session for `type='dm'` rows. For
   * `type='channel'` rows, holds an empty string (`''`) — the row is
   * not bound to a single agent. Phase B SEALED design §3.1.
   */
  agent_session: string;
  owner_user_id: string;
  name: string;
  purpose: string | null;
  created_at: number;
  archived_at: number | null;
  last_message_at: number | null;
  /**
   * Phase B addition (SEALED §3.1). `'dm'` for the existing 1:1 channels
   * (default — preserves backwards-compat); `'channel'` for new
   * team-scoped surfaces. NOT NULL after migration; existing rows
   * backfill to `'dm'`.
   */
  type: ChatChannelType;
  /**
   * Phase B addition (SEALED §3.1). Links a channel to a Crewly team
   * workspace. Required for `type='channel'`; null/empty for `type='dm'`
   * (which is user↔agent, not team-scoped).
   */
  team_id: string | null;
  /**
   * Phase B addition (SEALED §3.1). Optional link to a specific
   * project for project-scoped channels (e.g. `#proj-<name>`). Null
   * for team-general channels and DMs.
   */
  project_id: string | null;
  /**
   * Phase B addition (SEALED §3.1). For `type='dm'` rows, optionally
   * holds the target member-ID being DM'd (distinct from
   * `agent_session` which is the wire-level session binding). For
   * `type='channel'` rows, always null.
   */
  target_member_id: string | null;
}

/** Row shape of `chat_messages`. */
export interface ChatMessageRow {
  id: string;
  channel_id: string;
  seq: number;
  sender_type: ChatSenderType;
  sender_id: string;
  content: string;
  content_type: ChatContentType;
  created_at: number;
  /** JSON blob (string) or null. Bounded at 2KB at insert time. */
  metadata: string | null;
  /**
   * Phase B addition (SEALED §3.2). JSON-encoded array of mention IDs
   * referenced inline in `content` (member IDs and/or team IDs). Stored
   * as JSON string in SQLite (no native JSON column); empty array when
   * no mentions. Bounded at 1KB at insert time. Null on legacy rows;
   * service layer treats null as `[]`.
   */
  mentions: string | null;
  /**
   * Phase B addition (SEALED §3.2). Optional Slack-style threading
   * within a channel — when set, this message is a reply within the
   * thread rooted at `thread_id`. Null for top-level messages.
   */
  thread_id: string | null;
}

/** Row shape of `chat_attachments`. */
export interface ChatAttachmentRow {
  id: string;
  message_id: string;
  kind: 'image';
  mime_type: string;
  size_bytes: number;
  local_path: string;
  original_name: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Wire-format DTOs (REST + WS response bodies) — match spec §21
// ---------------------------------------------------------------------------

/** Outbound channel shape for `GET /channels` / `POST /channels`. */
export interface ChatChannelDTO {
  id: string;
  /**
   * Wire-level session binding for `type='dm'` channels. Empty string
   * for `type='channel'` rows.
   */
  agentSession: string;
  name: string;
  purpose?: string;
  createdAt: number;
  archivedAt?: number | null;
  lastMessageAt?: number | null;
  /**
   * Agent-presence summary. Populated for `type='dm'` channels (the
   * agent on the other side of the DM). For `type='channel'` rows,
   * `status: 'offline'` and `lastSeenAt: null` until the FE wires
   * per-member presence in Phase C.
   */
  agentPresence: {
    status: ChatAgentPresenceStatus;
    lastSeenAt: number | null;
  };
  /** Pending entries in the offline queue for this channel. */
  queuedCount?: number;
  /**
   * Phase B (SEALED §3.1) — `'dm'` (existing default) or `'channel'`
   * (new team-scoped surfaces). Required field on the wire from Phase B
   * onward; legacy callers that omit it are treated as `'dm'`.
   */
  type: ChatChannelType;
  /** Phase B — team workspace ID. Required when `type='channel'`. */
  teamId?: string;
  /** Phase B — project link. Optional even when `type='channel'`. */
  projectId?: string;
  /**
   * Phase B — for `type='dm'`, the target member's ID. Optional in
   * Week-2 contract because `agentSession` already disambiguates.
   * Provided when the FE wants to render a member-level handle
   * (`@Sam`) rather than the session ID.
   */
  targetMemberId?: string;
  /**
   * Phase B-2 (2026-05-17) — for `type='huddle'` channels, the explicit
   * member roster (agent session names). Populated by
   * `ChatV2Service.listChannel` from `chat_channel_members`. Undefined
   * for `'dm'` and `'channel'` rows.
   */
  members?: ChatHuddleMember[];
}

/**
 * A single member of a huddle channel. Wire shape kept minimal — the
 * frontend cross-references `sessionName` against the agent directory
 * for human-readable name, role, presence, etc.
 */
export interface ChatHuddleMember {
  /** Agent session name (matches `DirectoryAgent.agentSession`). */
  sessionName: string;
  /** ISO ms timestamp when this member was added to the huddle. */
  joinedAt: number;
}

/** Outbound message shape for `GET /messages` / `POST /messages` / WS `message` frame. */
export interface ChatMessageDTO {
  id: string;
  channelId: string;
  seq: number;
  senderType: ChatSenderType;
  senderId: string;
  content: string;
  contentType: ChatContentType;
  createdAt: number;
  attachments: ChatAttachmentDTO[];
  metadata?: Record<string, unknown>;
  /**
   * Phase B (SEALED §3.2) — array of mention IDs referenced inline in
   * `content`. Each entry is either a member ID or a team ID; the
   * `kind` discrimination is left to consumers via a separate lookup
   * (we do not embed `MentionTarget` shape in the wire to keep DTOs
   * shallow). Empty array when no mentions; never null on the wire.
   */
  mentions: string[];
  /**
   * Phase B (SEALED §3.2) — optional Slack-style thread root. When
   * present, this message is a reply within the thread; consumers
   * group by `threadId` to render the thread sub-pane.
   */
  threadId?: string;
  /**
   * Slack-style threading — number of replies whose `threadId` equals
   * this message's `id`. Populated only for root messages (those whose
   * own `threadId` is unset) that have at least one reply, via a single
   * per-page aggregate query in `listMessages`. Undefined when there are
   * no replies; reply rows never carry this field.
   */
  replyCount?: number;
  /**
   * Slack-style threading — ISO 8601 timestamp of the most recent reply
   * in this message's thread. Paired with `replyCount`; undefined when
   * there are no replies.
   */
  lastReplyAt?: string;
}

/** Outbound attachment shape — image only in Phase 1. */
export interface ChatAttachmentDTO {
  id: string;
  mimeType: string;
  sizeBytes: number;
  /** Relative path used by clients, e.g. `/api/chat/attachments/<id>`. */
  url: string;
  originalName?: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Opaque cursor payload before base64url encoding. */
export interface ChatMessageCursorPayload {
  seq: number;
  channelId: string;
}

/** Response envelope for `GET /channels/:id/messages`. */
export interface ChatMessageListResult {
  messages: ChatMessageDTO[];
  nextCursor: string | null;
  prevCursor: string | null;
  channelId: string;
}

// ---------------------------------------------------------------------------
// Input shapes (validated at controller; never exposed to DB directly)
// ---------------------------------------------------------------------------

/** Body of `POST /channels`. */
export interface CreateChannelInput {
  /**
   * Wire-level session binding. Required when `type='dm'` (default);
   * ignored when `type='channel'` (server stores empty string).
   */
  agentSession?: string;
  name: string;
  purpose?: string;
  /**
   * Phase B addition (SEALED §3.1). `'dm'` (default — preserves
   * Week-2 contract for callers that omit this field) or `'channel'`.
   * Service layer rejects `type='channel'` requests that omit `teamId`.
   */
  type?: ChatChannelType;
  /** Phase B — required when `type='channel'`. */
  teamId?: string;
  /** Phase B — optional even when `type='channel'`. */
  projectId?: string;
  /** Phase B — optional for `type='dm'`. */
  targetMemberId?: string;
}

/** Body of `POST /channels/:id/messages`. */
export interface SendMessageInput {
  content: string;
  contentType?: ChatContentType;
  clientMessageId?: string;
  /** Pre-uploaded attachment refs; Phase 1 is `{ attachmentId }` shape. */
  attachments?: Array<{ attachmentId: string }>;
  /**
   * Phase B (SEALED §3.2) — mention IDs (member or team) referenced
   * inline in `content`. The FE composer parses chips into this
   * shape before send; the BE persists as JSON and emits with the
   * outbound message DTO. Empty array or omitted = no mentions.
   */
  mentions?: string[];
  /**
   * Phase B (SEALED §3.2) — Slack-style thread reply root. When set,
   * the new message is a reply within the thread. Omit for top-level
   * channel messages.
   */
  threadId?: string;
}

/** Principal passed down from auth middleware. */
export interface ChatPrincipal {
  userId: string;
  /** When an agent (not a user) is acting. Phase 1 is usually undefined. */
  agentSession?: string;
  /** Origin — `portal` for Cloud Pro service-token requests. */
  source?: 'portal' | 'oss';
}

// ---------------------------------------------------------------------------
// Error codes — stable strings; `@crewly/chat-ui` switches UI state on them
// ---------------------------------------------------------------------------

/** Canonical error-code strings. */
export const CHAT_ERROR_CODES = {
  VALIDATION: 'validation_error',
  NOT_FOUND: 'not_found',
  CHANNEL_NOT_FOUND: 'channel_not_found',
  AGENT_NOT_FOUND: 'agent_not_found',
  FORBIDDEN: 'forbidden',
  /**
   * F2b (#333) — caller is authenticated but is not a member of the
   * `teamId` they tried to bind a `type='channel'` channel to. Distinct
   * from FORBIDDEN so the FE can surface a tenant-specific message
   * instead of a generic 403.
   */
  FORBIDDEN_TEAM: 'forbidden_team',
  AGENT_ALREADY_BOUND: 'agent_already_bound',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  RATE_LIMITED: 'rate_limited',
  INVALID_CURSOR: 'invalid_cursor',
  CHANNEL_ARCHIVED: 'channel_archived',
  ATTACHMENT_NOT_FOUND: 'attachment_not_found',
  INTERNAL: 'internal_error',
} as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES];

/** Structured error thrown by stores/service; controller maps to HTTP. */
export class ChatError extends Error {
  constructor(
    public readonly code: ChatErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

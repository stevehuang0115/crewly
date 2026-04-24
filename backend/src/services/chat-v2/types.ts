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

/** Enum values exposed as readonly tuples for runtime validation. */
export const CHAT_SENDER_TYPES: readonly ChatSenderType[] = ['user', 'agent', 'system'];
export const CHAT_CONTENT_TYPES: readonly ChatContentType[] = [
  'text',
  'markdown',
  'image_ref',
  'system_note',
];

// ---------------------------------------------------------------------------
// DB row shapes (1:1 with DDL in sqlite/chat-db.ts)
// ---------------------------------------------------------------------------

/** Row shape of `chat_channels`. Timestamps are ms-since-epoch UTC. */
export interface ChatChannelRow {
  id: string;
  agent_session: string;
  owner_user_id: string;
  name: string;
  purpose: string | null;
  created_at: number;
  archived_at: number | null;
  last_message_at: number | null;
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
  agentSession: string;
  name: string;
  purpose?: string;
  createdAt: number;
  archivedAt?: number | null;
  lastMessageAt?: number | null;
  agentPresence: {
    status: ChatAgentPresenceStatus;
    lastSeenAt: number | null;
  };
  /** Pending entries in the offline queue for this channel. */
  queuedCount?: number;
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
  agentSession: string;
  name: string;
  purpose?: string;
}

/** Body of `POST /channels/:id/messages`. */
export interface SendMessageInput {
  content: string;
  contentType?: ChatContentType;
  clientMessageId?: string;
  /** Pre-uploaded attachment refs; Phase 1 is `{ attachmentId }` shape. */
  attachments?: Array<{ attachmentId: string }>;
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

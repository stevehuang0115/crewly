/**
 * Wire-format DTO translation.
 *
 * Sam's backend (`backend/src/services/chat-v2/types.ts`) stores timestamps
 * as ms-since-epoch, uses flat `senderType`/`senderId` fields, and nests
 * presence under `agentPresence`. Our UI-facing types use ISO strings, a
 * nested `author` object, and a flat `presence` field — these are more
 * React-friendly and carry over from the Mock client we built in Phase 1
 * Week 1.
 *
 * Rather than rewriting the UI types to match wire DTOs (which would
 * cascade through every component + hook + test), we translate at the
 * client boundary. The public `ChatApiClient` contract is unchanged;
 * `HttpChatApiClient` just maps wire ↔ domain before returning to the
 * hooks layer.
 *
 * @module api/dto
 */

import type {
  Channel,
  Message,
  MessageAttachment,
  AgentPresence,
  AgentPresenceStatus,
} from '../types/chat.types';

// ---------------------------------------------------------------------------
// Wire-format DTOs (mirror backend/src/services/chat-v2/types.ts §21)
// ---------------------------------------------------------------------------

/** Backend `ChatAgentPresenceStatus`. Includes `starting` which maps to `online` on the UI. */
type WirePresenceStatus = 'online' | 'busy' | 'offline' | 'starting';

/** Shape of the agent-presence block inside a channel DTO. */
export interface ChannelPresenceDTO {
  status: WirePresenceStatus;
  lastSeenAt: number | null;
}

/** Wire shape for `GET /channels` list entry + `POST /channels` response. */
export interface ChannelDTO {
  id: string;
  agentSession: string;
  name: string;
  purpose?: string;
  createdAt: number;
  archivedAt?: number | null;
  lastMessageAt?: number | null;
  agentPresence: ChannelPresenceDTO;
  queuedCount?: number;
}

/** Wire shape for messages. */
export interface MessageDTO {
  id: string;
  channelId: string;
  seq: number;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  content: string;
  contentType: 'text' | 'markdown' | 'image_ref' | 'system_note';
  createdAt: number;
  attachments: AttachmentDTO[];
  metadata?: Record<string, unknown>;
}

/** Wire shape for attachments (Phase 1 image only). */
export interface AttachmentDTO {
  id: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  originalName?: string;
}

/** Envelope returned by `GET /channels`. */
export interface ChannelListEnvelope {
  channels: ChannelDTO[];
  nextCursor: string | null;
}

/** Envelope returned by `GET /channels/:id/messages`. */
export interface MessageListEnvelope {
  channelId: string;
  messages: MessageDTO[];
  nextCursor: string | null;
  prevCursor: string | null;
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

/** Translate a ms timestamp to an ISO 8601 string. Null-safe. */
function msToIso(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined) return undefined;
  return new Date(ms).toISOString();
}

/** Backend presence `starting` has no UI concept — surface as `online`. */
function translatePresence(status: WirePresenceStatus): AgentPresenceStatus {
  return status === 'starting' ? 'online' : status;
}

/** Build a display name for the message author. For user messages, reuse
 * the `senderId` (the user's id) so at least something renders; UIs can
 * later swap in the real display name from their user store. */
function authorNameForRole(
  role: 'user' | 'agent' | 'system',
  senderId: string,
): string | undefined {
  if (role === 'system') return 'System';
  // Agents have session names like `crewly-product-sam-...`; humans will
  // come from a separate user service. Fall back to senderId so the UI
  // never shows `undefined`.
  return senderId;
}

// ---------------------------------------------------------------------------
// Wire → Domain translators
// ---------------------------------------------------------------------------

export function channelFromDTO(dto: ChannelDTO): Channel {
  return {
    id: dto.id,
    agentSession: dto.agentSession,
    name: dto.name,
    purpose: dto.purpose,
    createdAt: new Date(dto.createdAt).toISOString(),
    lastMessageAt: msToIso(dto.lastMessageAt),
    presence: translatePresence(dto.agentPresence.status),
  };
}

export function attachmentFromDTO(dto: AttachmentDTO): MessageAttachment {
  return {
    id: dto.id,
    kind: 'image',
    url: dto.url,
    filename: dto.originalName,
    size: dto.sizeBytes,
    mimeType: dto.mimeType,
  };
}

export function messageFromDTO(dto: MessageDTO): Message {
  return {
    id: dto.id,
    channelId: dto.channelId,
    seq: dto.seq,
    author: {
      role: dto.senderType,
      id: dto.senderId,
      name: authorNameForRole(dto.senderType, dto.senderId),
    },
    content: dto.content,
    attachments: dto.attachments?.map(attachmentFromDTO),
    createdAt: new Date(dto.createdAt).toISOString(),
    // Freshly-persisted messages from the server are implicitly `sent`.
    deliveryStatus: 'sent',
  };
}

export function agentPresenceFromDTO(dto: {
  agentSession: string;
  status: WirePresenceStatus;
  lastSeenAt: number | null;
}): AgentPresence {
  return {
    agentId: dto.agentSession,
    status: translatePresence(dto.status),
    lastSeen: msToIso(dto.lastSeenAt),
  };
}

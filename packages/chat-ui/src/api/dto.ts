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
  ChatWebsocketEvent,
} from '../types/chat.types';

// ---------------------------------------------------------------------------
// Wire-format DTOs (mirror backend/src/services/chat-v2/types.ts §21)
// ---------------------------------------------------------------------------

/** Backend `ChatAgentPresenceStatus`. Includes `starting` which maps to `online` on the UI. */
export type WirePresenceStatus = 'online' | 'busy' | 'offline' | 'starting';

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
  /**
   * Phase B (SEALED §3.1) — `'dm'` (legacy default) or `'channel'`
   * (team-scoped surfaces). Required field on the wire from Phase B
   * onward; legacy callers that omit it are treated as `'dm'`.
   */
  type?: 'dm' | 'channel';
  /** Phase B — team workspace ID; required when `type='channel'`. */
  teamId?: string;
  /** Phase B — project link; optional even when `type='channel'`. */
  projectId?: string;
  /** Phase B — for `type='dm'`, the target member's id. */
  targetMemberId?: string;
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
  /**
   * Phase B (SEALED §3.2) — array of mention IDs (member or team) in
   * `content`. The BE service guarantees `mentions: string[]` (never
   * null) on the wire; the translator below preserves that invariant
   * by defaulting to `[]` when the field is missing on legacy / mock
   * payloads.
   */
  mentions?: string[];
  /**
   * Phase B (SEALED §3.2) — Slack-style thread root. Present when this
   * message is a reply within a thread; consumers group by `threadId`.
   */
  threadId?: string;
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
// Wire-format WS events (Sam's tech spec §6)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of wire-format frames the server may send on
 * `/ws/chat`. Translated to the domain `ChatWebsocketEvent` at the client
 * boundary.
 */
export type WireWebsocketEvent =
  | { type: 'message'; payload: { channelId: string; message: MessageDTO } }
  | {
      type: 'presence';
      payload: { agentSession: string; status: WirePresenceStatus; lastSeenAt?: number | null };
    }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

/** Translate a ms timestamp to an ISO 8601 string. Null-safe. */
function msToIso(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined) return undefined;
  return new Date(ms).toISOString();
}

/** Backend presence `starting` has no UI concept — surface as `online`. */
export function translatePresence(status: WirePresenceStatus): AgentPresenceStatus {
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

/**
 * Pull `clientMessageId` out of a message's `metadata` envelope.
 *
 * Sam's contract: server echoes the caller's idempotency token in
 * `metadata.clientMessageId` for both the HTTP 201 response body and the
 * WS broadcast frame. The client uses this to reconcile optimistic
 * pending records with the persisted row.
 *
 * @param metadata - Raw metadata bag from the backend
 * @returns The token if present and string-shaped; `undefined` otherwise
 */
function extractClientMessageId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const v = metadata['clientMessageId'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
    // Phase B — Slack-like fields. Default `type` to `'dm'` so legacy
    // (pre-Phase B) BE payloads continue to render as DMs.
    type: dto.type ?? 'dm',
    teamId: dto.teamId,
    projectId: dto.projectId,
    targetMemberId: dto.targetMemberId,
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
    // Server-echoed idempotency token; powers optimistic reconciliation.
    clientMessageId: extractClientMessageId(dto.metadata),
    // Freshly-persisted messages from the server are implicitly `sent`.
    deliveryStatus: 'sent',
    // Phase B (SEALED §3.2) — `mentions` is `string[]` on the wire and
    // never null; default to `[]` defensively if a legacy / mock payload
    // omits the field, so domain consumers can rely on `m.mentions`.
    mentions: Array.isArray(dto.mentions) ? dto.mentions : [],
    threadId: dto.threadId,
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

/**
 * Translate a wire-format WS frame to the domain `ChatWebsocketEvent`
 * shape consumers see.
 *
 * Returns `null` for frames that are valid JSON but don't match any known
 * event type (forward-compat). The caller should ignore null returns.
 *
 * @param wire - Parsed wire frame
 * @returns Domain event or `null` if the frame is unrecognized
 */
export function wsEventFromWire(wire: unknown): ChatWebsocketEvent | null {
  if (!wire || typeof wire !== 'object') return null;
  const w = wire as { type?: string };

  if (w.type === 'message') {
    const payload = (wire as { payload?: { channelId?: unknown; message?: unknown } }).payload;
    if (!payload || typeof payload.channelId !== 'string' || !payload.message) return null;
    return {
      type: 'message',
      channelId: payload.channelId,
      message: messageFromDTO(payload.message as MessageDTO),
    };
  }

  if (w.type === 'presence') {
    const payload = (
      wire as {
        payload?: {
          agentSession?: unknown;
          status?: unknown;
          lastSeenAt?: number | null;
        };
      }
    ).payload;
    if (!payload || typeof payload.agentSession !== 'string' || typeof payload.status !== 'string') {
      return null;
    }
    return {
      type: 'presence',
      agentSession: payload.agentSession,
      status: translatePresence(payload.status as WirePresenceStatus),
      lastSeen: msToIso(payload.lastSeenAt ?? null),
    };
  }

  if (w.type === 'pong') {
    const ts = (wire as { ts?: unknown }).ts;
    return { type: 'pong', ts: typeof ts === 'number' ? ts : 0 };
  }

  if (w.type === 'error') {
    const code = (wire as { code?: unknown }).code;
    const message = (wire as { message?: unknown }).message;
    return {
      type: 'error',
      code: typeof code === 'string' ? code : 'unknown',
      message: typeof message === 'string' ? message : '',
    };
  }

  return null;
}

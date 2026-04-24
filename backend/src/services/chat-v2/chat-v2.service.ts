/**
 * ChatV2Service — orchestrator for the Agent-First Chat MVP.
 *
 * Wires ChannelStore + MessageStore, enforces the authorization rules
 * laid out in the tech spec §7.2, and maps DB rows to wire-format DTOs.
 *
 * WebSocket push, offline queuing, and attachment durability land in
 * later passes of Phase 1 — see §18 rollout plan.
 *
 * @module services/chat-v2/chat-v2.service
 */

import type { ChatV2Config } from './config.js';
import { ChannelStore } from './sqlite/channel.store.js';
import { MessageStore } from './sqlite/message.store.js';
import { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
import {
  CHAT_CONTENT_TYPES,
  CHAT_ERROR_CODES,
  ChatError,
  type ChatAttachmentDTO,
  type ChatChannelDTO,
  type ChatChannelRow,
  type ChatContentType,
  type ChatMessageDTO,
  type ChatMessageListResult,
  type ChatMessageRow,
  type ChatPrincipal,
  type ChatSenderType,
} from './types.js';

// ---------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------

/** Constructor options for `ChatV2Service`. */
export interface ChatV2ServiceOptions {
  config: ChatV2Config;
  /** Optional pre-opened DB (tests pass an in-memory handle). */
  db?: ChatDatabase;
  /** Presence lookup — wired to `AgentRegistrationService` in wiring; tests pass a stub. */
  getPresence?: (agentSession: string) => {
    status: ChatChannelDTO['agentPresence']['status'];
    lastSeenAt: number | null;
  };
  /** Clock override for tests. */
  now?: () => number;
}

/** Minimal interface the service needs from a presence provider. */
export interface ChatPresenceProvider {
  getPresence(agentSession: string): {
    status: ChatChannelDTO['agentPresence']['status'];
    lastSeenAt: number | null;
  };
}

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/** Arguments for `createChannel`. */
export interface CreateChannelArgs {
  agentSession: string;
  name: string;
  purpose?: string;
  principal: ChatPrincipal;
}

/** Arguments for `listChannels`. */
export interface ListChannelsArgs {
  principal: ChatPrincipal;
  includeArchived?: boolean;
  limit?: number;
}

/** Arguments for `sendMessage`. */
export interface SendMessageArgs {
  channelId: string;
  principal: ChatPrincipal;
  content: string;
  contentType?: ChatContentType;
  clientMessageId?: string;
  /** Attachment hooks — the store is added in a later step, so pre-resolved DTOs are accepted. */
  attachments?: ChatAttachmentDTO[];
}

/** Arguments for `listMessages`. */
export interface ListMessagesArgs {
  channelId: string;
  principal: ChatPrincipal;
  cursor?: string | null;
  limit?: number;
  direction?: 'backward' | 'forward';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Default presence provider used until AgentRegistrationService is wired. */
const DEFAULT_PRESENCE = () => ({
  status: 'offline' as const,
  lastSeenAt: null,
});

/**
 * Orchestrator for chat domain operations.
 *
 * Responsibilities:
 * - Owns the DB handle + stores.
 * - Enforces authorization per §7.2.
 * - Maps rows → DTOs.
 * - Fans out to WebSocket / adapters in later phases.
 */
export class ChatV2Service {
  readonly config: ChatV2Config;
  private readonly db: ChatDatabase;
  private readonly channels: ChannelStore;
  private readonly messages: MessageStore;
  private readonly presence: ChatV2ServiceOptions['getPresence'];
  private readonly now: () => number;

  constructor(options: ChatV2ServiceOptions) {
    this.config = options.config;
    this.db = options.db ?? openChatDatabase({ dbPath: options.config.storage.dbPath });
    this.channels = new ChannelStore(this.db);
    this.messages = new MessageStore(this.db);
    this.presence = options.getPresence ?? DEFAULT_PRESENCE;
    this.now = options.now ?? Date.now;
  }

  /** Release the DB handle. Safe to call during graceful shutdown / in tests. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // swallow — nothing to do if already closed
    }
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  /**
   * Create a channel bound 1:1 to an agent session. Server always assigns
   * `owner_user_id = principal.userId` — the body's owner fields are ignored.
   *
   * @param args - Channel creation args
   * @returns The created channel as a DTO
   * @throws {ChatError} `validation_error` / `agent_already_bound`
   */
  createChannel(args: CreateChannelArgs): ChatChannelDTO {
    const name = (args.name ?? '').trim();
    if (name.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'name is required');
    }
    if (name.length > this.config.maxChannelNameChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `name exceeds ${this.config.maxChannelNameChars} characters`,
      );
    }
    const agentSession = (args.agentSession ?? '').trim();
    if (agentSession.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'agentSession is required');
    }

    const purpose = args.purpose?.trim();
    if (purpose && purpose.length > this.config.maxPurposeChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `purpose exceeds ${this.config.maxPurposeChars} characters`,
      );
    }

    const row = this.channels.create({
      agentSession,
      ownerUserId: args.principal.userId,
      name,
      purpose: purpose || null,
      nowMs: this.now(),
    });
    return this.toChannelDTO(row);
  }

  /**
   * List channels owned by the caller.
   *
   * @param args - List args
   * @returns DTO-mapped channels
   */
  listChannels(args: ListChannelsArgs): ChatChannelDTO[] {
    const rows = this.channels.listByOwner(args.principal.userId, {
      includeArchived: args.includeArchived,
      limit: args.limit,
    });
    return rows.map((r) => this.toChannelDTO(r));
  }

  /**
   * Look up a single channel the caller owns.
   *
   * @param channelId - Channel id
   * @param principal - Auth principal
   * @returns DTO shape
   * @throws {ChatError} `channel_not_found` (404) if the caller doesn't own it
   */
  getChannel(channelId: string, principal: ChatPrincipal): ChatChannelDTO {
    const row = this.requireOwnedChannel(channelId, principal);
    return this.toChannelDTO(row);
  }

  /**
   * Archive a channel. Returns true if a row was modified.
   *
   * @param channelId - Channel id
   * @param principal - Auth principal
   * @returns True if newly archived, false if already archived
   * @throws {ChatError} `channel_not_found` (404)
   */
  archiveChannel(channelId: string, principal: ChatPrincipal): boolean {
    this.requireOwnedChannel(channelId, principal);
    return this.channels.archive(channelId, this.now());
  }

  // -------------------------------------------------------------------------
  // Message operations
  // -------------------------------------------------------------------------

  /**
   * Persist a message sent by the caller. The server decides `sender_type`
   * and `sender_id` from the auth principal; client fields are ignored.
   *
   * @param args - Send args
   * @returns The persisted message as a DTO (fresh or deduped)
   * @throws {ChatError} on validation, authorization, or size limit
   */
  sendMessage(args: SendMessageArgs): ChatMessageDTO {
    const row = this.requireReadableChannel(args.channelId, args.principal);

    const content = args.content ?? '';
    if (content.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'content is required');
    }
    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen > this.config.maxMessageBytes) {
      throw new ChatError(
        CHAT_ERROR_CODES.PAYLOAD_TOO_LARGE,
        413,
        `content exceeds max bytes (${this.config.maxMessageBytes})`,
        { maxBytes: this.config.maxMessageBytes, yourBytes: byteLen },
      );
    }

    const contentType: ChatContentType = args.contentType ?? 'markdown';
    if (!CHAT_CONTENT_TYPES.includes(contentType)) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, `unknown contentType: ${contentType}`);
    }
    // Agents/users cannot self-tag as system.
    if (contentType === 'system_note' && this.resolveSender(row, args.principal).type !== 'system') {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'system_note can only be emitted server-side',
      );
    }

    const { type: senderType, id: senderId } = this.resolveSender(row, args.principal);

    const { row: persisted } = this.messages.insert({
      channelId: args.channelId,
      senderType,
      senderId,
      content,
      contentType,
      clientMessageId: args.clientMessageId,
      nowMs: this.now(),
    });

    return this.toMessageDTO(persisted, args.attachments ?? []);
  }

  /**
   * Page messages for a channel the caller may read.
   *
   * @param args - List args
   * @returns A pagination envelope
   * @throws {ChatError} on auth or invalid cursor
   */
  listMessages(args: ListMessagesArgs): ChatMessageListResult {
    this.requireReadableChannel(args.channelId, args.principal);

    const page = this.messages.listByChannel(args.channelId, {
      cursor: args.cursor ?? null,
      limit: args.limit,
      direction: args.direction,
    });

    return {
      channelId: args.channelId,
      messages: page.rows.map((r) => this.toMessageDTO(r, [])),
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
    };
  }

  // -------------------------------------------------------------------------
  // Authorization helpers (§7.2)
  // -------------------------------------------------------------------------

  /** Fetch the channel and enforce caller = owner. */
  private requireOwnedChannel(channelId: string, principal: ChatPrincipal): ChatChannelRow {
    const row = this.channels.getById(channelId);
    if (!row) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    if (row.owner_user_id !== principal.userId) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    return row;
  }

  /**
   * Fetch the channel and allow if the caller is the owner OR the bound agent.
   * Used for read + send; agents must always be acting from their own session.
   */
  private requireReadableChannel(channelId: string, principal: ChatPrincipal): ChatChannelRow {
    const row = this.channels.getById(channelId);
    if (!row) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    const isOwner = row.owner_user_id === principal.userId;
    const isBoundAgent =
      !!principal.agentSession && principal.agentSession === row.agent_session;
    if (!isOwner && !isBoundAgent) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    if (row.archived_at) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_ARCHIVED, 404, 'Channel is archived');
    }
    return row;
  }

  /** Decide sender_type + sender_id for a message based on principal + channel. */
  private resolveSender(
    channel: ChatChannelRow,
    principal: ChatPrincipal,
  ): { type: ChatSenderType; id: string } {
    if (principal.agentSession && principal.agentSession === channel.agent_session) {
      return { type: 'agent', id: principal.agentSession };
    }
    if (principal.userId === channel.owner_user_id) {
      return { type: 'user', id: principal.userId };
    }
    // Server-minted system messages go through an internal path, not this one.
    throw new ChatError(CHAT_ERROR_CODES.FORBIDDEN, 403, 'Principal cannot send in this channel');
  }

  // -------------------------------------------------------------------------
  // DTO mappers
  // -------------------------------------------------------------------------

  /** Map a channel row + live presence into the wire DTO. */
  private toChannelDTO(row: ChatChannelRow): ChatChannelDTO {
    const presence = (this.presence ?? DEFAULT_PRESENCE)(row.agent_session);
    return {
      id: row.id,
      agentSession: row.agent_session,
      name: row.name,
      purpose: row.purpose ?? undefined,
      createdAt: row.created_at,
      archivedAt: row.archived_at ?? null,
      lastMessageAt: row.last_message_at ?? null,
      agentPresence: {
        status: presence.status,
        lastSeenAt: presence.lastSeenAt,
      },
    };
  }

  /** Map a message row to the wire DTO. Attachments passed in by the caller. */
  private toMessageDTO(row: ChatMessageRow, attachments: ChatAttachmentDTO[]): ChatMessageDTO {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
    }
    return {
      id: row.id,
      channelId: row.channel_id,
      seq: row.seq,
      senderType: row.sender_type,
      senderId: row.sender_id,
      content: row.content,
      contentType: row.content_type,
      createdAt: row.created_at,
      attachments,
      metadata,
    };
  }
}

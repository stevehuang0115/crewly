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
  CHAT_CHANNEL_TYPES,
  CHAT_CONTENT_TYPES,
  CHAT_ERROR_CODES,
  CHAT_SENDER_TYPES,
  ChatError,
  type ChatAttachmentDTO,
  type ChatChannelDTO,
  type ChatChannelRow,
  type ChatChannelType,
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
  /**
   * F2b (#333) — outer-ring tenant defense. Called when creating a
   * `type='channel'` channel; if the principal cannot bind a channel
   * to `teamId`, return false → `createChannel` throws
   * `forbidden_team` (HTTP 403). Sync only, since `createChannel` runs
   * inside the synchronous `runHandler` wrapper (an async refactor is
   * a Phase E concern, not a F2b requirement).
   *
   * In OSS production, wire to a check that confirms `teamId` exists
   * in `StorageService.getTeams()` — single-user OSS treats existence
   * as membership. Cloud Portal Phase E swaps in a real user-tenant
   * binding check.
   *
   * When omitted (legacy tests, REST-only fixtures) `createChannel`
   * preserves pre-F2b behavior: only validates teamId is non-empty.
   * The composition root in `backend/src/index.ts` MUST inject this
   * to close the leak in production.
   */
  validateTeamMembership?: (
    principal: ChatPrincipal,
    teamId: string,
  ) => boolean;
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
  /**
   * Wire-level session binding. Required when `type='dm'` (default);
   * for `type='channel'`, callers may omit it (server stores '').
   */
  agentSession?: string;
  name: string;
  purpose?: string;
  principal: ChatPrincipal;
  /**
   * Phase A (SEALED §3.1) — channel kind. Defaults to `'dm'` to preserve
   * the Phase 1 contract for callers that omit this field.
   */
  type?: ChatChannelType;
  /** Phase A — required when `type='channel'`. */
  teamId?: string;
  /** Phase A — optional even when `type='channel'`. */
  projectId?: string;
  /** Phase A — optional when `type='dm'`. */
  targetMemberId?: string;
}

/** Arguments for `listChannels`. */
export interface ListChannelsArgs {
  principal: ChatPrincipal;
  includeArchived?: boolean;
  limit?: number;
  /**
   * Phase C — filter to a single channel type. The controller validates
   * the wire value against {@link CHAT_CHANNEL_TYPES} before reaching
   * this layer; an unknown value is rejected as `validation_error`.
   */
  type?: ChatChannelType;
  /**
   * Phase C — filter to channels with this `team_id`. Empty string is
   * treated the same as `undefined` (no filter) so callers don't have
   * to pre-normalize blank query strings. The store-level filter still
   * uses an exact-match against the column, so DMs (which have null
   * team_id) drop out of the result.
   */
  teamId?: string;
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
  /**
   * Phase A (SEALED §3.2) — array of mention IDs (member or team)
   * referenced inline in `content`. Persisted as JSON; emitted on the
   * outbound message DTO. Empty / omitted → no mentions.
   */
  mentions?: string[];
  /**
   * Phase A (SEALED §3.2) — Slack-style thread reply root. When set,
   * the new message is a reply within the thread rooted at this id;
   * the service validates that the thread root lives in the same
   * channel before persisting.
   */
  threadId?: string;
}

/**
 * Allowed values for `RecordTurnInput.metadata.source` — the audit-trail
 * discriminator that identifies which subsystem produced the message.
 *
 * Per spec `2026-05-14-unified-chat-message-store.md`, every {@link
 * ChatV2Service.recordTurn} caller MUST set `metadata.source` to one of
 * these values. The set is intentionally closed so future audits can
 * `GROUP BY metadata->>'$.source'` without surprise values.
 */
export const RECORD_TURN_SOURCES = [
  'web',
  'slack',
  'pty-runtime',
  'in-process-runtime',
  'reply-tool',
  'system',
] as const;

/** Union type of the values in {@link RECORD_TURN_SOURCES}. */
export type RecordTurnSource = (typeof RECORD_TURN_SOURCES)[number];

/** Server-internal write input for {@link ChatV2Service.recordTurn}. */
export interface RecordTurnInput {
  channelId: string;
  /** Server resolved — runtime/controller already knows who's sending. */
  senderType: ChatSenderType;
  /** User id, agent session name, or `'system'`. */
  senderId: string;
  content: string;
  contentType?: ChatContentType;
  /** Stable idempotency key — dedup keyed on `(channel_id, clientMessageId)`. */
  clientMessageId?: string;
  /** Optional thread-root reference; validated to live in the same channel. */
  threadId?: string;
  /** Optional inline mention ids (member or team). */
  mentions?: string[];
  /** Required audit metadata. Caller MUST set `source`. */
  metadata: {
    source: RecordTurnSource;
    /** Which agent runtime emitted the message, when applicable. */
    runtime?: 'claude-code' | 'gemini-cli' | 'crewly-agent';
    /** Slack correlation fields for cross-store reconciliation. */
    slackChannelId?: string;
    slackThreadTs?: string;
    /** Free-form additional context — not parsed by the store. */
    [key: string]: unknown;
  };
}

/** Result of {@link ChatV2Service.recordTurn}. */
export interface RecordTurnResult {
  /** The persisted (or pre-existing, when deduped) message DTO. */
  message: ChatMessageDTO;
  /** True when `clientMessageId` matched an existing row. */
  deduped: boolean;
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
  /** Phase A spec §3.2: max mention count per message. */
  static readonly MAX_MENTIONS_PER_MESSAGE = 50;
  /** Phase A spec §3.2: max JSON-encoded byte size of the mentions array. */
  static readonly MAX_MENTIONS_JSON_BYTES = 1024;

  readonly config: ChatV2Config;
  private readonly db: ChatDatabase;
  private readonly channels: ChannelStore;
  private readonly messages: MessageStore;
  private readonly presence: ChatV2ServiceOptions['getPresence'];
  private readonly validateTeamMembership: ChatV2ServiceOptions['validateTeamMembership'];
  private readonly now: () => number;

  constructor(options: ChatV2ServiceOptions) {
    this.config = options.config;
    this.db = options.db ?? openChatDatabase({ dbPath: options.config.storage.dbPath });
    this.channels = new ChannelStore(this.db);
    this.messages = new MessageStore(this.db);
    this.presence = options.getPresence ?? DEFAULT_PRESENCE;
    this.validateTeamMembership = options.validateTeamMembership;
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

  /**
   * Count every persisted chat message across every channel.
   *
   * Onboarding v3 (B1) — surfaced for the cold-start detector. Defers to
   * `MessageStore.countAll()`. Intentionally bypasses the principal /
   * authorization layer because the caller is the orchestrator bootstrap,
   * which runs without an HTTP-request principal context. The detector
   * only needs an unsigned "is the store empty" answer; no row contents
   * are exposed.
   *
   * @returns Total message count across all channels (0 on a fresh install)
   */
  countAllMessages(): number {
    return this.messages.countAll();
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  /**
   * Create a channel bound 1:1 to an agent session. Server always assigns
   * `owner_user_id = principal.userId` — the body's owner fields are ignored.
   *
   * F2b (#333): when `type='channel'` and a `validateTeamMembership` provider
   * is wired into the service, the principal must be authorized for the
   * requested `teamId`. Failures throw `forbidden_team` (403) — distinct
   * from generic `forbidden` so the FE can surface a tenant-specific
   * message.
   *
   * @param args - Channel creation args
   * @returns The created channel as a DTO
   * @throws {ChatError} `validation_error` (400) / `forbidden_team` (403) /
   *   `agent_already_bound` (409)
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

    // Phase A: validate channel type (defaults to 'dm' for backwards compat).
    const channelType: ChatChannelType = args.type ?? 'dm';
    if (!CHAT_CHANNEL_TYPES.includes(channelType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown channel type: ${channelType}`,
      );
    }

    // agentSession requirement is type-dependent:
    //   - 'dm'      → required (existing Phase 1 contract).
    //   - 'channel' → not 1:1-bound; server stores '' even if caller passed
    //                 something. Keep this strict so the wire shape matches
    //                 the design and we don't accidentally bind a team
    //                 channel to a single agent.
    const rawAgentSession = (args.agentSession ?? '').trim();
    let agentSession: string;
    if (channelType === 'dm') {
      if (rawAgentSession.length === 0) {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          "agentSession is required when type='dm'",
        );
      }
      agentSession = rawAgentSession;
    } else {
      // channel: discard any caller-supplied agentSession.
      agentSession = '';
    }

    // Phase A: type='channel' must specify a teamId; type='dm' may
    // optionally carry a targetMemberId. Reject the contradicting cases.
    const teamId = args.teamId?.trim() || undefined;
    const projectId = args.projectId?.trim() || undefined;
    const targetMemberId = args.targetMemberId?.trim() || undefined;

    if (channelType === 'channel' && !teamId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "teamId is required when type='channel'",
      );
    }
    if (channelType === 'dm' && teamId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "teamId must be omitted when type='dm'",
      );
    }
    if (channelType === 'channel' && targetMemberId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "targetMemberId must be omitted when type='channel'",
      );
    }

    // F2b (#333) — outer-ring tenant defense. type='channel' bindings
    // must pass the membership check when one is wired. Pre-checks
    // already confirmed `teamId` is present and non-empty by here.
    if (channelType === 'channel' && teamId && this.validateTeamMembership) {
      const isMember = this.validateTeamMembership(args.principal, teamId);
      if (!isMember) {
        throw new ChatError(
          CHAT_ERROR_CODES.FORBIDDEN_TEAM,
          403,
          'caller is not a member of the requested team',
          { teamId, userId: args.principal.userId },
        );
      }
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
      type: channelType,
      teamId: teamId ?? null,
      projectId: projectId ?? null,
      targetMemberId: targetMemberId ?? null,
      nowMs: this.now(),
    });
    return this.toChannelDTO(row);
  }

  /**
   * List channels owned by the caller.
   *
   * Phase C: extended with optional `type` + `teamId` filters so the
   * channel-rail can request a focused slice (e.g. "channels in this
   * workspace only") without paging the full owner-scoped list. An
   * unknown `type` value is rejected as `validation_error`. Blank
   * `teamId` is normalized to "no filter" so callers don't need to
   * sanitize empty query strings.
   *
   * @param args - List args (principal + optional filters)
   * @returns DTO-mapped channels
   * @throws {ChatError} `validation_error` (400) when `type` is set
   *   to a value outside {@link CHAT_CHANNEL_TYPES}.
   */
  listChannels(args: ListChannelsArgs): ChatChannelDTO[] {
    if (args.type !== undefined && !CHAT_CHANNEL_TYPES.includes(args.type)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown channel type: ${args.type}`,
      );
    }
    // Treat blank teamId the same as omitted — saves the channel-rail FE
    // from having to strip empty query strings before issuing the GET.
    const teamIdFilter =
      args.teamId !== undefined && args.teamId.trim().length > 0
        ? args.teamId
        : undefined;

    const rows = this.channels.listByOwner(args.principal.userId, {
      includeArchived: args.includeArchived,
      limit: args.limit,
      type: args.type,
      teamId: teamIdFilter,
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

    // Phase A: validate mentions array. Bounded count + JSON-byte cap so
    // a misbehaving client cannot blow past the spec §3.2 1KB ceiling.
    const mentions = this.validateMentions(args.mentions);

    // Phase A: validate threadId — must reference an existing message in
    // this channel; refusing dangling thread refs prevents orphan replies
    // and contains UX confusion if the FE composes against a stale id.
    const threadId = this.validateThreadId(args.threadId, args.channelId);

    const { row: persisted } = this.messages.insert({
      channelId: args.channelId,
      senderType,
      senderId,
      content,
      contentType,
      clientMessageId: args.clientMessageId,
      mentions,
      threadId,
      nowMs: this.now(),
    });

    return this.toMessageDTO(persisted, args.attachments ?? []);
  }

  /**
   * Canonical server-internal write entry for chat messages.
   *
   * Unlike {@link sendMessage}, which derives `sender_type` / `sender_id`
   * from an authenticated request principal, `recordTurn` is the path
   * used by runtimes, controllers, and bridges that have already
   * resolved exactly who the sender is — e.g.:
   *
   *   - In-process agent runtime finishing a turn
   *   - PTY runtime emitting a complete reply
   *   - Slack inbound bridge persisting a user DM
   *   - `/slack/send` controller persisting the agent's outbound reply
   *
   * Per spec `2026-05-14-unified-chat-message-store.md`, every chat
   * write in the system funnels through this method. No caller should
   * write to {@link MessageStore} directly; no caller should reach
   * into legacy {@link ChatService} (Phase 6 retires it).
   *
   * Idempotent via `clientMessageId` — the underlying store dedups by
   * `(channel_id, clientMessageId)` and returns the existing row with
   * `deduped=true` instead of inserting a duplicate.
   *
   * @param input - Turn payload (channel, sender, content, metadata)
   * @returns The persisted message DTO + dedupe flag
   * @throws {ChatError} `channel_not_found` (404) if the channel is missing
   * @throws {ChatError} `validation_error` (400) on empty content or invalid contentType
   * @throws {ChatError} `payload_too_large` (413) if content exceeds maxMessageBytes
   *
   * @example
   * ```typescript
   * const { message, deduped } = chatV2.recordTurn({
   *   channelId: 'slack-D0AC7-1234',
   *   senderType: 'agent',
   *   senderId: 'crewly-orc',
   *   content: 'Hello!',
   *   clientMessageId: 'agent-finish-2026-05-14T22:30:00Z',
   *   metadata: {
   *     source: 'in-process-runtime',
   *     runtime: 'crewly-agent',
   *     slackChannelId: 'D0AC7',
   *     slackThreadTs: '1234',
   *   },
   * });
   * ```
   */
  recordTurn(input: RecordTurnInput): RecordTurnResult {
    const content = input.content ?? '';
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

    const contentType: ChatContentType = input.contentType ?? 'markdown';
    if (!CHAT_CONTENT_TYPES.includes(contentType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown contentType: ${contentType}`,
      );
    }

    if (!CHAT_SENDER_TYPES.includes(input.senderType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown senderType: ${input.senderType}`,
      );
    }
    if (!input.senderId || input.senderId.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'senderId is required');
    }

    const mentions = this.validateMentions(input.mentions);
    const threadId = this.validateThreadId(input.threadId, input.channelId);

    // `metadata.source` is the audit-trail discriminator that lets
    // future tooling tell "this message came from PTY" vs "from
    // in-process runtime" vs "from /slack/send" without parsing
    // content. Spec success criterion #4 depends on this tag being
    // present for every recordTurn caller.
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (!metadata.source) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'metadata.source is required for recordTurn (audit trail)',
      );
    }
    if (!RECORD_TURN_SOURCES.includes(metadata.source as RecordTurnSource)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown metadata.source: ${String(metadata.source)}`,
        { allowed: RECORD_TURN_SOURCES },
      );
    }

    const { row: persisted, deduped } = this.messages.insert({
      channelId: input.channelId,
      senderType: input.senderType,
      senderId: input.senderId,
      content,
      contentType,
      clientMessageId: input.clientMessageId,
      mentions,
      threadId,
      metadata,
      nowMs: this.now(),
    });

    return {
      message: this.toMessageDTO(persisted, []),
      deduped,
    };
  }

  /**
   * Phase A — validate the mentions array passed to sendMessage.
   * Returns the cleaned array (or undefined when input is empty/missing).
   *
   * @param raw - The raw `mentions` field from the request body
   * @returns Validated mention IDs (caller passes to messageStore)
   * @throws {ChatError} `validation_error` (400) on type / size / count violation
   */
  private validateMentions(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'mentions must be an array');
    }
    if (raw.length === 0) return undefined;
    if (raw.length > ChatV2Service.MAX_MENTIONS_PER_MESSAGE) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `mentions exceeds max count (${ChatV2Service.MAX_MENTIONS_PER_MESSAGE})`,
      );
    }
    const cleaned: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          'mentions entries must be strings',
        );
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          'mentions entries must be non-empty',
        );
      }
      cleaned.push(trimmed);
    }
    // Bound the JSON size — spec §3.2 caps mentions JSON at 1KB.
    const jsonByteLen = Buffer.byteLength(JSON.stringify(cleaned), 'utf-8');
    if (jsonByteLen > ChatV2Service.MAX_MENTIONS_JSON_BYTES) {
      throw new ChatError(
        CHAT_ERROR_CODES.PAYLOAD_TOO_LARGE,
        413,
        `mentions JSON exceeds max bytes (${ChatV2Service.MAX_MENTIONS_JSON_BYTES})`,
      );
    }
    return cleaned;
  }

  /**
   * Phase A — validate the threadId passed to sendMessage.
   *
   * Returns the original threadId if it's a valid reference to a message
   * in the same channel, or undefined when input is empty/missing.
   * Refuses dangling references and cross-channel thread roots.
   *
   * @param raw - The raw `threadId` field from the request body
   * @param channelId - The channel this message will be inserted into
   * @returns Validated thread root id (caller passes to messageStore)
   * @throws {ChatError} `validation_error` (400) when invalid
   */
  private validateThreadId(raw: unknown, channelId: string): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'threadId must be a string');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;

    const root = this.messages.getById(trimmed);
    if (!root) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `threadId references a non-existent message`,
        { threadId: trimmed },
      );
    }
    if (root.channel_id !== channelId) {
      // Returning validation_error (not channel_not_found) because the
      // caller's intent IS valid — they're just pointing at the wrong
      // channel's thread root. Distinct error helps debugging.
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `threadId belongs to a different channel`,
        { threadId: trimmed, expectedChannelId: channelId },
      );
    }
    return trimmed;
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
    // Phase B backwards-compat: legacy rows (pre-migration) lack `type` /
    // team scope fields. The migration backfills `type='dm'` for existing
    // rows; here we defend the in-memory path against rows that may not
    // yet have the column populated (e.g. mid-migration test runs).
    const channelType = row.type ?? 'dm';
    const presenceSource = channelType === 'dm' ? row.agent_session : '';
    const presence = (this.presence ?? DEFAULT_PRESENCE)(presenceSource);
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
      type: channelType,
      teamId: row.team_id ?? undefined,
      projectId: row.project_id ?? undefined,
      targetMemberId: row.target_member_id ?? undefined,
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
    // Phase B backwards-compat: parse mentions from JSON-encoded array
    // column. Legacy rows (pre-migration) have null; we surface as
    // empty array so the wire contract `mentions: string[]` is never
    // violated. A malformed JSON column also falls back to `[]` rather
    // than throwing — the wire contract is the priority.
    let mentions: string[] = [];
    if (row.mentions) {
      try {
        const parsed = JSON.parse(row.mentions) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          mentions = parsed as string[];
        }
      } catch {
        mentions = [];
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
      mentions,
      threadId: row.thread_id ?? undefined,
    };
  }
}

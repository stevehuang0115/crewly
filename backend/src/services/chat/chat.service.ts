/**
 * Chat Service — facade over ChatV2Service.
 *
 * Phase 6 of the unified-chat-message-store spec
 * (`specs/2026-05-14-unified-chat-message-store.md`):
 * the legacy JSON-file storage at `~/.crewly/chat/` is retired.
 * All chat persistence and read paths now flow through the canonical
 * `ChatV2Service` (SQLite at `~/.crewly/chat.db`). This file remains
 * temporarily as a deprecation shim so the many legacy callers
 * (`chat.controller.ts`, `chat.gateway.ts`, `slack-orchestrator-bridge.ts`,
 * `notify-reconciliation.service.ts`, `message-replay.service.ts`,
 * `index.ts`) continue to compile and run while they are migrated to
 * call ChatV2Service directly. Each facade method translates between
 * the legacy `ChatMessage` / `ChatConversation` DTOs and chat-v2's
 * `ChatMessageDTO` / `ChatChannelDTO` so existing event subscribers
 * (chat.gateway.ts) see the same shapes they always have.
 *
 * @module services/chat/chat.service
 */

import { EventEmitter } from 'events';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
  ChatMessage,
  ChatConversation,
  ChatSender,
  ChatChannelType,
  SendMessageInput,
  SendMessageResult,
  ChatMessageFilter,
  ConversationFilter,
  ChatContentType,
  ChatMessageEvent,
  ChatTypingEvent,
  ConversationUpdatedEvent,
} from '../../types/chat.types.js';

/**
 * Default page size for legacy `getMessages` calls without an explicit
 * `filter.limit`. Matches the historical hardcoded value so the change
 * to honor `filter.limit` is a strict superset of the prior behavior.
 */
const LEGACY_DEFAULT_PAGE_SIZE = 200;

/**
 * Hard cap on `getMessages` limit, applied after the caller-supplied
 * value. Keeps a buggy/malicious caller from asking chat-v2 to load
 * the entire channel history into a single response. Requests above
 * this are clamped (documented contract), never silently truncated
 * below it: a limit larger than chat-v2's per-page cap
 * (`MessageStore.MAX_LIMIT`, 100) is served by walking several
 * chat-v2 pages.
 */
const LEGACY_MAX_PAGE_SIZE = 1000;

/**
 * Upper bound on how many chat-v2 rows a single legacy read may scan.
 *
 * Legacy filters (`senderType`, `contentType`, timestamp `before`/`after`)
 * have no chat-v2 equivalent, so they are applied while walking chat-v2
 * pages until `limit` matches are found or the channel is exhausted. This
 * bound stops a sparse filter on a huge channel from turning one HTTP
 * request into an unbounded table scan; when it is hit the result (or
 * count) is a best-effort subset and a warning is logged.
 */
const LEGACY_MAX_SCAN_ROWS = 20_000;

/**
 * Pick the chat-v2 `metadata.source` for a legacy `addAgentMessage`
 * /`addDirectMessage` call. Returns the caller-provided
 * `metadata.source` when it is one of the closed chat-v2 source enum
 * values, otherwise falls back to `defaultSource` (the historical
 * hardcoded value for the call site).
 *
 * @param metadata - Legacy metadata blob (possibly undefined)
 * @param defaultSource - Source to use when metadata has no valid source
 * @returns A chat-v2 `RecordTurnSource` value
 */
function resolveLegacyRecordSource(
  metadata: Record<string, unknown> | undefined,
  defaultSource: 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool' | 'system',
): 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool' | 'system' {
  const raw = metadata?.source;
  if (
    raw === 'web' ||
    raw === 'slack' ||
    raw === 'pty-runtime' ||
    raw === 'in-process-runtime' ||
    raw === 'reply-tool' ||
    raw === 'system'
  ) {
    return raw;
  }
  return defaultSource;
}
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import { ChatError, CHAT_ERROR_CODES } from '../chat-v2/types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import { MessageStore, encodeCursor } from '../chat-v2/sqlite/message.store.js';
import {
  SYSTEM_PRINCIPAL,
  senderToV2,
  v2MessageToLegacy,
  v2ChannelToLegacy,
  inferSourceFromLegacyMetadata,
  synthesizeSlackConversationId,
} from '../chat-v2/legacy-dto.utils.js';

/**
 * Whether an error is chat-v2's "channel not found" (404) error.
 *
 * The legacy façade contract maps a missing conversation to either a
 * `ConversationNotFoundError` (mutations) or an empty result (reads);
 * this predicate lets each method translate chat-v2's typed error.
 *
 * @param err - Any thrown value
 * @returns True when `err` is a `ChatError` with code `channel_not_found`
 */
function isChannelNotFound(err: unknown): boolean {
  return err instanceof ChatError && err.code === CHAT_ERROR_CODES.CHANNEL_NOT_FOUND;
}

/**
 * A resolved legacy `before` / `after` boundary.
 *
 * - `seq`: the caller passed the id of a message in the conversation; the
 *   boundary is that message's chat-v2 sequence number (exact, gap-free
 *   even for same-millisecond messages, and lets the walk start at a
 *   chat-v2 cursor instead of scanning).
 * - `timestamp`: anything else is treated as an ISO-8601 timestamp and
 *   compared as a string, exactly like the original JSON-backed service.
 */
type LegacyAnchor = { kind: 'seq'; seq: number } | { kind: 'timestamp'; value: string };

/** The resolved `before` / `after` window of a legacy message read. */
interface LegacyWindow {
  /** Exclusive upper bound, or null for "up to the newest message". */
  before: LegacyAnchor | null;
  /** Exclusive lower bound, or null for "from the first message". */
  after: LegacyAnchor | null;
}

/**
 * Whether a message lies strictly before (is older than) an anchor.
 *
 * @param dto - chat-v2 DTO (supplies `seq`)
 * @param legacy - The same message in legacy shape (supplies `timestamp`)
 * @param anchor - Resolved boundary
 * @returns True when the message is older than the anchor
 */
function isOlderThanAnchor(dto: ChatMessageDTO, legacy: ChatMessage, anchor: LegacyAnchor): boolean {
  return anchor.kind === 'seq' ? dto.seq < anchor.seq : legacy.timestamp < anchor.value;
}

/**
 * Whether a message lies strictly after (is newer than) an anchor.
 *
 * @param dto - chat-v2 DTO (supplies `seq`)
 * @param legacy - The same message in legacy shape (supplies `timestamp`)
 * @param anchor - Resolved boundary
 * @returns True when the message is newer than the anchor
 */
function isNewerThanAnchor(dto: ChatMessageDTO, legacy: ChatMessage, anchor: LegacyAnchor): boolean {
  return anchor.kind === 'seq' ? dto.seq > anchor.seq : legacy.timestamp > anchor.value;
}

/**
 * Apply the legacy per-message content filters (`senderType`,
 * `contentType`) that the original JSON-backed ChatService honored.
 * The `before` / `after` window is enforced by the paging walk itself.
 *
 * @param message - Legacy message to test
 * @param filter - Legacy message filter
 * @returns True when the message matches every supplied content filter
 */
function matchesLegacyContentFilters(message: ChatMessage, filter: ChatMessageFilter): boolean {
  return (
    (!filter.senderType || message.from.type === filter.senderType) &&
    (!filter.contentType || message.contentType === filter.contentType)
  );
}

/**
 * Resolve a legacy `filter.limit` to the effective page size: positive
 * finite values are honored (floored), anything else falls back to
 * {@link LEGACY_DEFAULT_PAGE_SIZE}, and the result is clamped to
 * {@link LEGACY_MAX_PAGE_SIZE}.
 *
 * @param raw - Caller-supplied limit (possibly undefined / NaN / <= 0)
 * @returns The limit to serve
 */
function resolveLegacyLimit(raw: number | undefined): number {
  const requested =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : LEGACY_DEFAULT_PAGE_SIZE;
  return Math.min(requested, LEGACY_MAX_PAGE_SIZE);
}

/**
 * Resolve a legacy `filter.offset` to a non-negative integer, or null
 * when the caller did not request offset pagination.
 *
 * @param raw - Caller-supplied offset
 * @returns The offset, or null for the default newest-tail read
 */
function resolveLegacyOffset(raw: number | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.floor(raw));
}

/**
 * Whether a legacy message filter narrows beyond the conversation id.
 *
 * @param filter - Legacy message filter
 * @returns True when any of senderType/contentType/after/before is set
 */
function hasLegacyMessageFilters(filter: ChatMessageFilter): boolean {
  return Boolean(filter.senderType || filter.contentType || filter.after || filter.before);
}

// =============================================================================
// Error classes — preserved for callers that catch them by name
// =============================================================================

export class ConversationNotFoundError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

// =============================================================================
// Service options — kept for source compatibility; chatDir is now ignored
// =============================================================================

export interface ChatServiceOptions {
  /** @deprecated Legacy filesystem path; ignored — storage is now SQLite. */
  chatDir?: string;
}

// =============================================================================
// ChatService facade
// =============================================================================

/**
 * Deprecated façade over ChatV2Service.
 *
 * Preserves the public surface of the original `ChatService` so the
 * remaining legacy callers compile unchanged. Internally every method
 * delegates to `ChatV2Service`. The original ~/.crewly/chat/*.json
 * storage layer has been removed.
 *
 * New code MUST NOT depend on this class; call `getChatV2Service()`
 * directly. Phase 6c of the spec deletes this file once all callers
 * are migrated.
 */
export class ChatService extends EventEmitter {
  private logger: ComponentLogger;
  private chatV2: ChatV2Service;

  constructor(_options?: ChatServiceOptions) {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('ChatService');
    this.chatV2 = getChatV2Service();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (no-ops — chat-v2 manages its own DB lifecycle)
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // chat-v2 lazy-initializes on first access; nothing to do.
  }

  isInitialized(): boolean {
    return true;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Send a user message. Idempotency via legacy callers' own
   * metadata.clientMessageId when present.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const conversationId = input.conversationId ?? this.synthesizeConversationId(input);
    const channel = this.chatV2.ensureChannelForLegacyConversation({
      conversationId,
      agentSession: 'crewly-orc',
    });
    const senderId =
      (typeof input.metadata?.userId === 'string' && input.metadata.userId) || 'user';
    const { message } = this.chatV2.recordTurn({
      channelId: channel.id,
      senderType: 'user',
      senderId,
      content: input.content,
      clientMessageId:
        typeof input.metadata?.clientMessageId === 'string'
          ? input.metadata.clientMessageId
          : undefined,
      // Source resolution here is intentionally STRICTER than
      // `recordViaFacade` (which uses `resolveLegacyRecordSource`).
      // `sendMessage` always writes `senderType: 'user'`, so the only
      // legitimate sources are 'web' or 'slack'. Caller-supplied values
      // like 'reply-tool' or 'pty-runtime' are agent-reply tags and
      // would be nonsensical on a user-authored row — `inferSource…`
      // downgrades them to 'system' on purpose. Phase 6α follow-up #5.
      metadata: {
        ...((input.metadata ?? {}) as Record<string, unknown>),
        source: inferSourceFromLegacyMetadata(input.metadata),
      },
    });
    const conversation = v2ChannelToLegacy(channel, this.chatV2.countChannelMessages(channel.id, SYSTEM_PRINCIPAL));
    const legacyMessage = v2MessageToLegacy(message);
    // Phase 6α follow-up #6: chat-v2 already emits 'chat_message' for
    // every fresh recordTurn write (chat-v2.service.ts:936/1063). The
    // chat.gateway WebSocket subscriber listens on the chat-v2
    // EventEmitter directly, so a second emit here would double-broadcast
    // to every connected client. The 'conversation_updated' event has no
    // chat-v2 equivalent yet, so we keep emitting that one until chat-v2
    // grows a channel-touched event.
    this.emitConversationUpdated(conversation);
    return { conversation, message: legacyMessage };
  }

  /**
   * Add an agent reply extracted from raw terminal output. The legacy
   * regex extraction (`[RESPONSE]` / `[CHAT_RESPONSE]` markers) is gone
   * — callers should pass already-clean content. Kept for source
   * compatibility with `chat.gateway.processTerminalOutput`, which has
   * no production callers post Phase 4 discovery.
   */
  async addAgentMessage(
    conversationId: string,
    rawOutput: string,
    sender: ChatSender,
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    // Phase 6α follow-up #5: source defaults to 'pty-runtime' (the
    // historical caller) but the caller can override via
    // `metadata.source` — e.g. an in-process runtime route should tag
    // its replies 'in-process-runtime', not 'pty-runtime'. Falling back
    // through inferSourceFromLegacyMetadata preserves the previous
    // default for callers that don't tag.
    const source = resolveLegacyRecordSource(metadata, 'pty-runtime');
    return this.recordViaFacade(conversationId, rawOutput, sender, metadata, source);
  }

  /**
   * Persist a pre-extracted markdown reply. Primary call site is the
   * PTY `[NOTIFY]` path in `chat.gateway.processNotifyMessage`.
   */
  async addDirectMessage(
    conversationId: string,
    content: string,
    sender: ChatSender,
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    // Phase 6α follow-up #5: see addAgentMessage. Same default + override.
    const source = resolveLegacyRecordSource(metadata, 'pty-runtime');
    return this.recordViaFacade(conversationId, content, sender, metadata, source);
  }

  /**
   * Add a server-side system note (progress markers, errors, etc.).
   */
  async addSystemMessage(
    conversationId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    return this.recordViaFacade(
      conversationId,
      content,
      { type: 'system', id: 'system', name: 'System' },
      metadata,
      'system',
    );
  }

  private async recordViaFacade(
    conversationId: string,
    content: string,
    sender: ChatSender,
    metadata: Record<string, unknown> | undefined,
    source: 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool' | 'system',
  ): Promise<ChatMessage> {
    const channel = this.chatV2.ensureChannelForLegacyConversation({
      conversationId,
      agentSession: 'crewly-orc',
    });
    const { type: senderType, id: senderId } = senderToV2(sender);
    const { message } = this.chatV2.recordTurn({
      channelId: channel.id,
      senderType,
      senderId,
      content,
      clientMessageId:
        typeof metadata?.clientMessageId === 'string' ? metadata.clientMessageId : undefined,
      // `source` AFTER the spread: the resolved source from
      // resolveLegacyRecordSource already incorporated metadata.source
      // (if valid) or fell back to the default. Putting it last
      // guarantees a value from the closed enum lands in the row
      // regardless of what the legacy caller passed.
      metadata: { ...((metadata ?? {}) as Record<string, unknown>), source },
    });
    const legacyMessage = v2MessageToLegacy(message);
    // Phase 6α follow-up #6: chat-v2 already emits 'chat_message';
    // chat.gateway subscribes to chat-v2 directly. No re-emit here to
    // avoid double-broadcasting to WebSocket clients.
    return legacyMessage;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Read messages from a conversation with the legacy filter contract.
   *
   * Semantics (matching the original JSON-backed service, issue #1000):
   * - Default (no `offset`): the NEWEST `limit` messages that match every
   *   filter, returned oldest → newest. `before` / `after` bound the window
   *   exclusively, so `before=<oldest loaded id|timestamp>` yields the
   *   `limit` messages immediately preceding that point ("load older"),
   *   and `after=<ts>` yields the newest `limit` messages after it (the
   *   original service also returned the newest tail when `after` was set,
   *   which is what `ChatHighlightsService` relies on).
   * - With `offset`: legacy offset pagination over the matching window,
   *   counted from the OLDEST message — skip `offset`, return `limit`.
   *
   * `before` / `after` accept a message id from this conversation (exact
   * seq boundary) or an ISO timestamp (string comparison, legacy).
   *
   * Implementation: walks chat-v2 `listMessages` pages through its cursors
   * (`backward` from the newest message or the `before` id; `forward` for
   * offset reads) and applies the content filters while walking, fetching
   * more pages until `limit` matches are found, the window boundary is
   * crossed, or the channel is exhausted. So a sparse filter does not
   * return fewer than `limit` messages while older matches exist — up to
   * the {@link LEGACY_MAX_SCAN_ROWS} scan bound. Stopping the walk at the
   * opposite boundary assumes chat-v2 `seq` order agrees with `createdAt`
   * order (both are assigned at insert time from the same clock).
   *
   * @param filter - Legacy message filter (`conversationId` required)
   * @returns Matching messages in chronological order; [] for an unknown
   *   conversation or when `conversationId` is missing
   * @throws Any chat-v2 error other than "channel not found"
   *
   * @example
   * ```typescript
   * const newest = await chatService.getMessages({ conversationId, limit: 50 });
   * const older = await chatService.getMessages({ conversationId, limit: 50, before: newest[0].id });
   * ```
   */
  async getMessages(filter: ChatMessageFilter): Promise<ChatMessage[]> {
    if (!filter.conversationId) {
      // Legacy callers occasionally call with no conversationId to get
      // everything. chat-v2 has no global query — return [] and let
      // the migration of those call sites surface explicit filters.
      return [];
    }
    const conversationId = filter.conversationId;
    const limit = resolveLegacyLimit(filter.limit);
    const offset = resolveLegacyOffset(filter.offset);
    try {
      const window = this.resolveLegacyWindow(conversationId, filter);
      return offset === null
        ? this.selectNewestInWindow(conversationId, filter, window, limit)
        : this.selectFromOffsetInWindow(conversationId, filter, window, offset, limit);
    } catch (err) {
      // Legacy contract: an unknown conversation reads as empty.
      if (isChannelNotFound(err)) return [];
      throw err;
    }
  }

  /**
   * Count messages in a conversation, honoring the same filters as
   * {@link getMessages} (`limit` / `offset` are ignored). Returns 0 for an
   * unknown conversation (legacy contract) instead of surfacing chat-v2's
   * 404. Unfiltered counts use chat-v2's count query; filtered counts walk
   * the same pages as `getMessages`, bounded by {@link LEGACY_MAX_SCAN_ROWS}.
   *
   * @param filter - Legacy message filter (`conversationId` required for a non-zero count)
   * @returns Number of matching messages
   * @throws Any chat-v2 error other than "channel not found"
   */
  async getMessageCount(filter: ChatMessageFilter): Promise<number> {
    if (!filter.conversationId) return 0;
    const conversationId = filter.conversationId;
    try {
      if (!hasLegacyMessageFilters(filter)) {
        return this.chatV2.countChannelMessages(conversationId, SYSTEM_PRINCIPAL);
      }
      const window = this.resolveLegacyWindow(conversationId, filter);
      return this.selectNewestInWindow(conversationId, filter, window, Number.POSITIVE_INFINITY)
        .length;
    } catch (err) {
      if (isChannelNotFound(err)) return 0;
      throw err;
    }
  }

  /**
   * Resolve a legacy `before` / `after` value to a boundary. A value that
   * is the id of a message in this conversation becomes an exact `seq`
   * boundary; anything else is treated as a timestamp.
   *
   * @param conversationId - Conversation being read
   * @param value - Raw `before` / `after` value
   * @returns The anchor, or null when no value was supplied
   */
  private resolveLegacyAnchor(
    conversationId: string,
    value: string | undefined,
  ): LegacyAnchor | null {
    if (!value) return null;
    const dto = this.chatV2.getMessageForBridge(value);
    if (dto && dto.channelId === conversationId) return { kind: 'seq', seq: dto.seq };
    return { kind: 'timestamp', value };
  }

  /**
   * Resolve both window boundaries of a legacy filter.
   *
   * @param conversationId - Conversation being read
   * @param filter - Legacy message filter
   * @returns The resolved window
   */
  private resolveLegacyWindow(conversationId: string, filter: ChatMessageFilter): LegacyWindow {
    return {
      before: this.resolveLegacyAnchor(conversationId, filter.before),
      after: this.resolveLegacyAnchor(conversationId, filter.after),
    };
  }

  /**
   * Walk a channel's messages through chat-v2 cursor pagination, one full
   * chat-v2 page (`MessageStore.MAX_LIMIT`) at a time. Pages are fetched
   * lazily, so a consumer that stops early never loads further pages.
   *
   * @param conversationId - Channel to walk
   * @param direction - `backward` = newest → oldest, `forward` = oldest → newest
   * @param startSeq - Exclusive starting seq, or null to start at the channel
   *   end (newest for backward, first message for forward)
   * @returns A generator of chat-v2 DTOs in walk order, at most
   *   {@link LEGACY_MAX_SCAN_ROWS} of them
   * @throws {ChatError} `channel_not_found` when the conversation does not exist
   */
  private *walkChannel(
    conversationId: string,
    direction: 'backward' | 'forward',
    startSeq: number | null,
  ): Generator<ChatMessageDTO, void, undefined> {
    let cursor: string | null =
      startSeq === null ? null : encodeCursor({ seq: startSeq, channelId: conversationId });
    let scanned = 0;
    do {
      const page = this.chatV2.listMessages({
        channelId: conversationId,
        principal: SYSTEM_PRINCIPAL,
        cursor,
        limit: MessageStore.MAX_LIMIT,
        direction,
      });
      for (const dto of page.messages) {
        if (scanned >= LEGACY_MAX_SCAN_ROWS) {
          this.logger.warn('Legacy chat read hit the scan bound; result is partial', {
            conversationId,
            direction,
            maxScanRows: LEGACY_MAX_SCAN_ROWS,
          });
          return;
        }
        scanned++;
        yield dto;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Select the newest `limit` messages inside the window that match the
   * content filters, walking backward from the `before` id (or the newest
   * message) and stopping at the `after` boundary.
   *
   * @param conversationId - Conversation being read
   * @param filter - Legacy message filter (content filters)
   * @param window - Resolved before/after window
   * @param limit - Max messages to return (`Infinity` to collect all, for counts)
   * @returns Matching messages, oldest → newest
   */
  private selectNewestInWindow(
    conversationId: string,
    filter: ChatMessageFilter,
    window: LegacyWindow,
    limit: number,
  ): ChatMessage[] {
    const newestFirst: ChatMessage[] = [];
    const startSeq = window.before?.kind === 'seq' ? window.before.seq : null;
    for (const dto of this.walkChannel(conversationId, 'backward', startSeq)) {
      const message = v2MessageToLegacy(dto);
      // Crossed the lower bound: every older message is outside the window.
      if (window.after && !isNewerThanAnchor(dto, message, window.after)) break;
      // Timestamp `before`: skip newer messages until the walk reaches it.
      if (window.before && !isOlderThanAnchor(dto, message, window.before)) continue;
      if (!matchesLegacyContentFilters(message, filter)) continue;
      newestFirst.push(message);
      if (newestFirst.length >= limit) break;
    }
    return newestFirst.reverse();
  }

  /**
   * Legacy offset pagination: skip the first `offset` matching messages of
   * the window (counted from the oldest) and return the next `limit`.
   *
   * @param conversationId - Conversation being read
   * @param filter - Legacy message filter (content filters)
   * @param window - Resolved before/after window
   * @param offset - Matching messages to skip, counted from the oldest
   * @param limit - Max messages to return
   * @returns Matching messages, oldest → newest
   */
  private selectFromOffsetInWindow(
    conversationId: string,
    filter: ChatMessageFilter,
    window: LegacyWindow,
    offset: number,
    limit: number,
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    let skipped = 0;
    const startSeq = window.after?.kind === 'seq' ? window.after.seq : null;
    for (const dto of this.walkChannel(conversationId, 'forward', startSeq)) {
      const message = v2MessageToLegacy(dto);
      // Crossed the upper bound: every newer message is outside the window.
      if (window.before && !isOlderThanAnchor(dto, message, window.before)) break;
      // Timestamp `after`: skip older messages until the walk reaches it.
      if (window.after && !isNewerThanAnchor(dto, message, window.after)) continue;
      if (!matchesLegacyContentFilters(message, filter)) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      result.push(message);
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Look up a single message by id within a conversation.
   *
   * @param conversationId - Conversation the message must belong to
   * @param messageId - The message id
   * @returns The legacy message, or null when absent or in another conversation
   */
  async getMessage(conversationId: string, messageId: string): Promise<ChatMessage | null> {
    const dto = this.chatV2.getMessageForBridge(messageId);
    if (!dto || dto.channelId !== conversationId) return null;
    return v2MessageToLegacy(dto);
  }

  async updateMessageMetadata(
    _conversationId: string,
    messageId: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<ChatMessage | null> {
    const dto = this.chatV2.updateMessageMetadata(messageId, metadataPatch);
    return dto ? v2MessageToLegacy(dto) : null;
  }

  async getMessagesWithPendingSlackDelivery(maxAgeMs: number): Promise<ChatMessage[]> {
    return this.chatV2.findMessagesWithPendingSlackDelivery(maxAgeMs).map(v2MessageToLegacy);
  }

  /**
   * List conversations in the legacy shape, honoring the legacy filters:
   * `includeArchived` (archived rows are hidden by default), `channelType`,
   * a case-insensitive title `search`, and `offset` / `limit` pagination.
   *
   * @param filter - Optional legacy conversation filter
   * @returns Matching conversations
   */
  async getConversations(filter?: ConversationFilter): Promise<ChatConversation[]> {
    const channels = this.chatV2.listChannels({
      principal: SYSTEM_PRINCIPAL,
      includeArchived: filter?.includeArchived === true,
    });
    let conversations = channels.map((c) =>
      v2ChannelToLegacy(c, this.chatV2.countChannelMessages(c.id, SYSTEM_PRINCIPAL)),
    );
    if (filter?.channelType) {
      conversations = conversations.filter((c) => c.channelType === filter.channelType);
    }
    if (filter?.search) {
      const needle = filter.search.toLowerCase();
      conversations = conversations.filter((c) => c.title?.toLowerCase().includes(needle));
    }
    if (filter?.offset !== undefined || filter?.limit !== undefined) {
      const offset = filter.offset ?? 0;
      conversations = conversations.slice(
        offset,
        filter.limit !== undefined ? offset + filter.limit : undefined,
      );
    }
    return conversations;
  }

  async getConversation(id: string): Promise<ChatConversation | null> {
    try {
      const channel = this.chatV2.getChannel(id, SYSTEM_PRINCIPAL);
      return v2ChannelToLegacy(channel, this.chatV2.countChannelMessages(id, SYSTEM_PRINCIPAL));
    } catch {
      return null;
    }
  }

  async createNewConversation(
    title?: string,
    idOverride?: string,
    _channelType?: ChatChannelType,
  ): Promise<ChatConversation> {
    const conversationId = idOverride ?? `web-conv-${Date.now()}`;
    const channel = this.chatV2.ensureChannelForLegacyConversation({
      conversationId,
      agentSession: 'crewly-orc',
      name: title ?? conversationId,
    });
    const conversation = v2ChannelToLegacy(channel, 0);
    this.emitConversationUpdated(conversation);
    return conversation;
  }

  /**
   * Rename a conversation.
   *
   * @param id - Conversation id
   * @param title - New title
   * @returns The updated conversation
   * @throws {ConversationNotFoundError} when the conversation does not exist
   */
  async updateConversationTitle(id: string, title: string): Promise<ChatConversation> {
    const conversation = this.withConversation(id, () => {
      const channel = this.chatV2.renameChannel(id, title, SYSTEM_PRINCIPAL);
      return v2ChannelToLegacy(channel, this.chatV2.countChannelMessages(id, SYSTEM_PRINCIPAL));
    });
    this.emitConversationUpdated(conversation);
    return conversation;
  }

  /**
   * Archive a conversation.
   *
   * @param id - Conversation id
   * @throws {ConversationNotFoundError} when the conversation does not exist
   */
  async archiveConversation(id: string): Promise<void> {
    this.withConversation(id, () => this.chatV2.archiveChannel(id, SYSTEM_PRINCIPAL));
    await this.emitConversationUpdatedById(id);
  }

  /**
   * Unarchive a conversation.
   *
   * @param id - Conversation id
   * @throws {ConversationNotFoundError} when the conversation does not exist
   */
  async unarchiveConversation(id: string): Promise<void> {
    this.withConversation(id, () => this.chatV2.unarchiveChannel(id, SYSTEM_PRINCIPAL));
    await this.emitConversationUpdatedById(id);
  }

  /**
   * Delete a conversation and its messages. Idempotent: deleting an
   * unknown conversation is a no-op (legacy contract).
   *
   * @param id - Conversation id
   */
  async deleteConversation(id: string): Promise<void> {
    try {
      this.chatV2.deleteChannel(id, SYSTEM_PRINCIPAL);
    } catch (err) {
      if (!isChannelNotFound(err)) throw err;
    }
  }

  async clearConversation(id: string): Promise<void> {
    this.chatV2.clearChannel(id, SYSTEM_PRINCIPAL);
  }

  async getCurrentConversation(): Promise<ChatConversation | null> {
    // Frontend should adopt "latest channel" via listChannels;
    // here we approximate by returning the most recently touched channel.
    const channels = this.chatV2.listChannels({ principal: SYSTEM_PRINCIPAL });
    if (channels.length === 0) return null;
    const newest = channels.reduce((a, b) =>
      (a.lastMessageAt ?? a.createdAt) > (b.lastMessageAt ?? b.createdAt) ? a : b,
    );
    return v2ChannelToLegacy(newest, this.chatV2.countChannelMessages(newest.id, SYSTEM_PRINCIPAL));
  }

  emitTypingIndicator(conversationId: string, sender: ChatSender, isTyping: boolean): void {
    this.emit('chat_typing', {
      type: 'chat_typing',
      data: { conversationId, sender, isTyping },
    } satisfies ChatTypingEvent);
  }

  emitProgress(conversationId: string, text: string): void {
    // Transient — emit but don't persist. Frontend renders progress
    // ephemerally. Legacy behaviour preserved.
    this.emit('chat_message', {
      type: 'chat_message',
      data: {
        id: `progress-${Date.now()}`,
        conversationId,
        from: { type: 'system', id: 'system', name: 'System' },
        content: text,
        contentType: 'system' as ChatContentType,
        status: 'sent',
        timestamp: new Date().toISOString(),
        metadata: { ephemeral: true },
      },
    } satisfies ChatMessageEvent);
  }

  async getStatistics(): Promise<{
    totalConversations: number;
    activeConversations: number;
    archivedConversations: number;
    totalMessages: number;
  }> {
    const s = this.chatV2.getStatistics();
    return {
      totalConversations: s.totalChannels,
      activeConversations: s.activeChannels,
      archivedConversations: s.archivedChannels,
      totalMessages: s.totalMessages,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a conversationId for a brand-new sendMessage call that
   * didn't supply one. Web-chat-style id; Slack callers always pass
   * their own slack-CHANNEL-TS identifier.
   */
  private synthesizeConversationId(input: SendMessageInput): string {
    if (typeof input.metadata?.channelId === 'string') {
      // Slack source — derive from channel + timestamp pattern.
      const channel = input.metadata.channelId;
      const ts = typeof input.metadata.threadTs === 'string' ? input.metadata.threadTs : `${Date.now()}`;
      return synthesizeSlackConversationId(channel, ts);
    }
    return `web-conv-${Date.now()}`;
  }

  /**
   * Emit the legacy `conversation_updated` event. chat-v2 has no
   * channel-touched event yet, so the façade remains its source and
   * `ChatGateway` forwards it to WebSocket clients (the chat sidebar
   * listens for it).
   *
   * @param conversation - The conversation in its new state
   */
  private emitConversationUpdated(conversation: ChatConversation): void {
    this.emit('conversation_updated', {
      type: 'conversation_updated',
      data: conversation,
    } satisfies ConversationUpdatedEvent);
  }

  /**
   * Re-read a conversation and emit `conversation_updated` for it.
   * No-op when the conversation no longer exists.
   *
   * @param id - Conversation id
   */
  private async emitConversationUpdatedById(id: string): Promise<void> {
    const conversation = await this.getConversation(id);
    if (conversation) this.emitConversationUpdated(conversation);
  }

  /**
   * Run a chat-v2 mutation on a conversation, translating chat-v2's
   * `channel_not_found` error into the legacy `ConversationNotFoundError`
   * that callers (chat.controller → 404) catch by type.
   *
   * @param id - Conversation id
   * @param fn - The chat-v2 operation
   * @returns Whatever `fn` returns
   * @throws {ConversationNotFoundError} when the conversation does not exist
   */
  private withConversation<T>(id: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (isChannelNotFound(err)) throw new ConversationNotFoundError(id);
      throw err;
    }
  }

  /**
   * @deprecated Will be removed when the façade is retired.
   */
  async ensureInitialized(): Promise<void> {
    /* no-op */
  }
}

// =============================================================================
// Singleton accessors — preserved for source compatibility
// =============================================================================

let _instance: ChatService | null = null;

export function getChatService(options?: ChatServiceOptions): ChatService {
  if (!_instance) {
    _instance = new ChatService(options);
  }
  return _instance;
}

export function resetChatService(): void {
  _instance = null;
}

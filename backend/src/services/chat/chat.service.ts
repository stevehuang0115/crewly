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
  inferChannelTypeFromConversationId,
} from '../../types/chat.types.js';
import type {
  ChatChannelDTO,
  ChatMessageDTO,
  ChatPrincipal,
  ChatSenderType,
} from '../chat-v2/types.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';

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
// DTO translation helpers (chat-v2 ↔ legacy)
// =============================================================================

const SYSTEM_PRINCIPAL: ChatPrincipal = { userId: 'system', source: 'oss' };

/**
 * Map a legacy ChatSender.type onto chat-v2 senderType + senderId.
 * Legacy types: 'user' | 'orchestrator' | 'agent' | 'system' | 'auditor' | ...
 * chat-v2 types: 'user' | 'agent' | 'system' (closed enum).
 */
function senderToV2(sender: ChatSender): { type: ChatSenderType; id: string } {
  const t = (sender?.type ?? '').toLowerCase();
  if (t === 'user') {
    return { type: 'user', id: sender.id ?? sender.name ?? 'user' };
  }
  if (t === 'system') {
    return { type: 'system', id: sender.id ?? 'system' };
  }
  // Everything else (orchestrator, agent, auditor, custom roles) maps to 'agent'
  return { type: 'agent', id: sender.id ?? sender.name ?? 'agent' };
}

/**
 * Translate a chat-v2 message DTO back to the legacy ChatMessage shape
 * the frontend / WebSocket subscribers expect.
 */
function v2MessageToLegacy(dto: ChatMessageDTO): ChatMessage {
  const fromType: ChatSender['type'] =
    dto.senderType === 'user'
      ? 'user'
      : dto.senderType === 'system'
        ? 'system'
        : 'orchestrator';
  return {
    id: dto.id,
    conversationId: dto.channelId,
    from: {
      type: fromType,
      id: dto.senderId,
      name: dto.senderId,
    },
    content: dto.content,
    contentType: (dto.contentType ?? 'markdown') as ChatContentType,
    metadata: (dto.metadata ?? {}) as Record<string, unknown>,
    status: 'sent',
    timestamp: new Date(dto.createdAt).toISOString(),
  };
}

/**
 * Translate a chat-v2 channel DTO back to the legacy ChatConversation
 * shape.
 */
function v2ChannelToLegacy(channel: ChatChannelDTO, messageCount: number): ChatConversation {
  return {
    id: channel.id,
    title: channel.name,
    participantIds: ['user', channel.agentSession || 'orchestrator'].filter(Boolean) as string[],
    createdAt: new Date(channel.createdAt).toISOString(),
    updatedAt: new Date(channel.lastMessageAt ?? channel.createdAt).toISOString(),
    isArchived: Boolean(channel.archivedAt),
    messageCount,
    channelType: inferChannelTypeFromConversationId(channel.id),
  };
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
      metadata: {
        source: this.inferSourceFromMetadata(input.metadata),
        ...((input.metadata ?? {}) as Record<string, unknown>),
      },
    });
    const conversation = v2ChannelToLegacy(channel, this.chatV2.countChannelMessages(channel.id, SYSTEM_PRINCIPAL));
    const legacyMessage = v2MessageToLegacy(message);
    this.emit('chat_message', { type: 'chat_message', data: legacyMessage } satisfies ChatMessageEvent);
    this.emit('conversation_updated', {
      type: 'conversation_updated',
      data: conversation,
    } satisfies ConversationUpdatedEvent);
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
    return this.recordViaFacade(conversationId, rawOutput, sender, metadata, 'pty-runtime');
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
    return this.recordViaFacade(conversationId, content, sender, metadata, 'pty-runtime');
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
      metadata: { source, ...((metadata ?? {}) as Record<string, unknown>) },
    });
    const legacyMessage = v2MessageToLegacy(message);
    this.emit('chat_message', { type: 'chat_message', data: legacyMessage } satisfies ChatMessageEvent);
    return legacyMessage;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getMessages(filter: ChatMessageFilter): Promise<ChatMessage[]> {
    if (!filter.conversationId) {
      // Legacy callers occasionally call with no conversationId to get
      // everything. chat-v2 has no global query — return [] and let
      // the migration of those call sites surface explicit filters.
      return [];
    }
    const page = this.chatV2.listMessages({
      channelId: filter.conversationId,
      principal: SYSTEM_PRINCIPAL,
      limit: 200,
      direction: 'forward',
    });
    return page.messages.map(v2MessageToLegacy);
  }

  async getMessageCount(filter: ChatMessageFilter): Promise<number> {
    if (!filter.conversationId) return 0;
    return this.chatV2.countChannelMessages(filter.conversationId, SYSTEM_PRINCIPAL);
  }

  async getMessage(_conversationId: string, _messageId: string): Promise<ChatMessage | null> {
    // chat-v2 has no per-message lookup yet; return null. Callers that
    // depend on this should be migrated to read the row from the
    // `chat_messages` table directly.
    return null;
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

  async getConversations(_filter?: ConversationFilter): Promise<ChatConversation[]> {
    const channels = this.chatV2.listChannels({ principal: SYSTEM_PRINCIPAL });
    return channels.map((c) =>
      v2ChannelToLegacy(c, this.chatV2.countChannelMessages(c.id, SYSTEM_PRINCIPAL)),
    );
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
    return v2ChannelToLegacy(channel, 0);
  }

  async updateConversationTitle(id: string, title: string): Promise<ChatConversation> {
    const channel = this.chatV2.renameChannel(id, title, SYSTEM_PRINCIPAL);
    return v2ChannelToLegacy(channel, this.chatV2.countChannelMessages(id, SYSTEM_PRINCIPAL));
  }

  async archiveConversation(id: string): Promise<void> {
    this.chatV2.archiveChannel(id, SYSTEM_PRINCIPAL);
  }

  async unarchiveConversation(id: string): Promise<void> {
    this.chatV2.unarchiveChannel(id, SYSTEM_PRINCIPAL);
  }

  async deleteConversation(id: string): Promise<void> {
    this.chatV2.deleteChannel(id, SYSTEM_PRINCIPAL);
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
      return `slack-${channel}-${String(ts).replace('.', '-')}`;
    }
    return `web-conv-${Date.now()}`;
  }

  /**
   * Infer the canonical `metadata.source` enum value from legacy
   * metadata. Falls back to 'system' when the legacy caller didn't
   * label the message.
   */
  private inferSourceFromMetadata(
    metadata: Record<string, unknown> | undefined,
  ): 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool' | 'system' {
    const src = metadata?.source;
    if (src === 'slack') return 'slack';
    if (src === 'web') return 'web';
    return 'system';
  }

  /**
   * @deprecated Will be removed in Phase 6c.
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

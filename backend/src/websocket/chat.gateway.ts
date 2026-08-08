/**
 * Chat Gateway Module
 *
 * Integrates chat functionality with the WebSocket infrastructure.
 * Forwards chat events from ChatService to connected clients.
 *
 * @module websocket/chat.gateway
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { getChatV2Service } from '../services/chat-v2/chat-v2.singleton.js';
import type { ChatV2Service } from '../services/chat-v2/chat-v2.service.js';
import type { ChatMessageDTO } from '../services/chat-v2/types.js';
import {
  SYSTEM_PRINCIPAL,
  v2MessageToLegacy,
  v2ChannelToLegacy,
  senderToV2,
} from '../services/chat-v2/legacy-dto.utils.js';
import { LoggerService, ComponentLogger } from '../services/core/logger.service.js';
import type { ChatMessage, ChatSender } from '../types/chat.types.js';

/**
 * Chat Gateway class for WebSocket-based chat messaging.
 *
 * Provides:
 * - Real-time chat message broadcasting
 * - Typing indicator support
 * - Conversation update notifications
 * - Terminal output to chat message processing
 */
export class ChatGateway {
  private io: SocketIOServer;
  private logger: ComponentLogger;
  private chatV2: ChatV2Service;
  private initialized = false;

  /**
   * Create a new ChatGateway.
   *
   * @param io - Socket.IO server instance
   */
  constructor(io: SocketIOServer) {
    this.io = io;
    this.logger = LoggerService.getInstance().createComponentLogger('ChatGateway');
    this.chatV2 = getChatV2Service();
  }

  /**
   * Initialize the chat gateway.
   *
   * Subscribes to chat-v2 message events and wires the
   * client-facing WebSocket handlers.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.setupChatV2Listeners();
    this.setupWebSocketHandlers();

    this.initialized = true;
    this.logger.info('ChatGateway initialized');
  }

  /**
   * Subscribe to ChatV2Service events and broadcast to WebSocket clients.
   * Phase 6c of the unified-chat-message-store spec — replaces the
   * legacy ChatService EventEmitter wiring.
   */
  private setupChatV2Listeners(): void {
    this.chatV2.on('chat_message', (dto: ChatMessageDTO) => {
      const legacy = v2MessageToLegacy(dto);
      this.logger.debug('Broadcasting chat_message', { messageId: legacy.id });
      this.broadcast('chat_message', {
        type: 'chat_message',
        data: legacy,
        timestamp: new Date().toISOString(),
      });
    });
  }

  /**
   * Set up WebSocket event handlers for chat-specific events.
   */
  private setupWebSocketHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      // Handle chat conversation subscription
      socket.on('subscribe_to_chat', async (conversationId?: string) => {
        this.logger.debug('Client subscribing to chat', {
          socketId: socket.id,
          conversationId,
        });

        // Join chat room
        socket.join('chat');

        if (conversationId) {
          socket.join(`chat_${conversationId}`);
        }

        // Send current conversation if requested
        if (conversationId) {
          try {
            const channel = this.chatV2.getChannel(conversationId, SYSTEM_PRINCIPAL);
            const messageCount = this.chatV2.countChannelMessages(conversationId, SYSTEM_PRINCIPAL);
            socket.emit('chat_conversation', {
              type: 'chat_conversation',
              data: v2ChannelToLegacy(channel, messageCount),
              timestamp: new Date().toISOString(),
            });
          } catch {
            // Channel not found / unauthorized — silently skip; the
            // client will see no chat_conversation event.
          }
        }

        socket.emit('chat_subscribed', {
          type: 'chat_subscribed',
          data: { conversationId },
          timestamp: new Date().toISOString(),
        });
      });

      // Handle unsubscription from chat
      socket.on('unsubscribe_from_chat', (conversationId?: string) => {
        socket.leave('chat');
        if (conversationId) {
          socket.leave(`chat_${conversationId}`);
        }
      });

      // Handle typing indicator from client
      socket.on('chat_typing', (data: { conversationId: string; isTyping: boolean }) => {
        // User typing indicators are just echoed to other clients
        socket.to(`chat_${data.conversationId}`).emit('chat_typing', {
          type: 'chat_typing',
          data: {
            conversationId: data.conversationId,
            sender: { type: 'user' as const },
            isTyping: data.isTyping,
          },
          timestamp: new Date().toISOString(),
        });
      });
    });
  }

  /**
   * Broadcast a message to all clients in the chat room.
   *
   * @param event - Event name
   * @param message - Message to broadcast
   */
  private broadcast(event: string, message: object): void {
    this.io.to('chat').emit(event, message);
  }

  /**
   * Broadcast a message to a specific conversation room.
   *
   * @param conversationId - Conversation ID
   * @param event - Event name
   * @param message - Message to broadcast
   */
  private broadcastToConversation(
    conversationId: string,
    event: string,
    message: object
  ): void {
    this.io.to(`chat_${conversationId}`).emit(event, message);
  }

  /**
   * Process terminal output and convert to chat message if applicable.
   *
   * Checks for response markers in terminal output and creates
   * chat messages from extracted content.
   *
   * @param sessionId - The session/agent ID that produced the output
   * @param output - Raw terminal output
   * @param conversationId - Target conversation ID
   * @returns The created chat message, or null if no response marker found
   */
  async processTerminalOutput(
    sessionId: string,
    output: string,
    conversationId?: string
  ): Promise<ChatMessage | null> {
    // Only process if there's an active conversation
    if (!conversationId) return null;

    // Check if output contains response markers
    const hasResponseMarker =
      output.includes('[RESPONSE]') ||
      output.includes('[CHAT_RESPONSE]') ||
      output.includes('```response');

    if (!hasResponseMarker) return null;

    try {
      const channel = this.chatV2.ensureChannelForLegacyConversation({
        conversationId,
        agentSession: 'crewly-orc',
      });
      const { message } = this.chatV2.recordTurn({
        channelId: channel.id,
        senderType: 'agent',
        senderId: sessionId,
        content: output,
        metadata: { source: 'pty-runtime', sessionId },
      });
      const legacyMessage = v2MessageToLegacy(message);

      this.logger.debug('Added agent message to chat', {
        messageId: legacyMessage.id,
        conversationId,
      });

      return legacyMessage;
    } catch (error) {
      this.logger.error('Failed to process terminal output for chat', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Process a unified [NOTIFY] message and add it directly to a conversation.
   *
   * Unlike `processTerminalOutput`, this method takes pre-extracted content
   * from a [NOTIFY] payload — no regex extraction needed. Optional metadata
   * (e.g. Slack delivery tracking fields) is merged into the message metadata.
   *
   * @param sessionId - The session/agent ID that produced the output
   * @param content - Pre-extracted markdown content from NotifyPayload.message
   * @param conversationId - Target conversation ID
   * @param metadata - Optional additional metadata to attach to the message
   * @returns The created chat message, or null on failure
   */
  async processNotifyMessage(
    sessionId: string,
    content: string,
    conversationId: string,
    metadata?: Record<string, unknown>
  ): Promise<ChatMessage | null> {
    try {
      const channel = this.chatV2.ensureChannelForLegacyConversation({
        conversationId,
        agentSession: 'crewly-orc',
      });
      const { message } = this.chatV2.recordTurn({
        channelId: channel.id,
        senderType: 'agent',
        senderId: sessionId,
        content,
        metadata: {
          sessionId,
          ...(metadata ?? {}),
          // `source` is set LAST so a caller cannot clobber the audit
          // discriminator. It is a closed enum (RECORD_TURN_SOURCES) owned by
          // this path; when a caller spread an out-of-enum value over it, the
          // write failed validation and the agent's reply was dropped after the
          // work was already done. Callers may add metadata, not redefine
          // where the turn came from.
          source: 'in-process-runtime',
        },
      });
      const legacyMessage = v2MessageToLegacy(message);

      this.logger.debug('Added notify message to chat', {
        messageId: legacyMessage.id,
        conversationId,
      });

      return legacyMessage;
    } catch (error) {
      this.logger.error('Failed to process notify message for chat', {
        sessionId,
        conversationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Emit a typing indicator for the orchestrator.
   *
   * Call this when the orchestrator starts/stops processing a message.
   *
   * @param conversationId - Conversation ID
   * @param isTyping - Whether the orchestrator is typing
   */
  emitOrchestratorTyping(conversationId: string, isTyping: boolean): void {
    this.broadcastTyping(conversationId, { type: 'orchestrator', name: 'Orchestrator' }, isTyping);
  }

  /**
   * Emit a typing indicator for an agent.
   *
   * @param conversationId - Conversation ID
   * @param sender - Agent sender information
   * @param isTyping - Whether the agent is typing
   */
  emitAgentTyping(conversationId: string, sender: ChatSender, isTyping: boolean): void {
    this.broadcastTyping(conversationId, sender, isTyping);
  }

  /**
   * Emit a typing indicator via the WebSocket broadcast channel.
   * Phase 6c: typing indicators were previously emitted on the
   * legacy ChatService EventEmitter; with that retired, the gateway
   * sources them directly. Typing is transient and never persisted,
   * so no chat-v2 write is involved.
   *
   * @param conversationId - Conversation ID
   * @param sender - Sender descriptor
   * @param isTyping - Whether the sender is typing
   */
  private broadcastTyping(
    conversationId: string,
    sender: ChatSender,
    isTyping: boolean,
  ): void {
    // Resolve sender type via the shared mapper so the wire shape
    // matches what existing subscribers expect.
    senderToV2(sender);
    this.broadcast('chat_typing', {
      type: 'chat_typing',
      data: { conversationId, sender, isTyping },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Check if the gateway is initialized.
   *
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let chatGatewayInstance: ChatGateway | null = null;

/**
 * Initialize the ChatGateway with a Socket.IO server.
 *
 * @param io - Socket.IO server instance
 * @returns The ChatGateway instance
 */
export async function initializeChatGateway(io: SocketIOServer): Promise<ChatGateway> {
  if (!chatGatewayInstance) {
    chatGatewayInstance = new ChatGateway(io);
    await chatGatewayInstance.initialize();
  }
  return chatGatewayInstance;
}

/**
 * Get the ChatGateway instance.
 *
 * @returns The ChatGateway instance or null if not initialized
 */
export function getChatGateway(): ChatGateway | null {
  return chatGatewayInstance;
}

/**
 * Reset the ChatGateway instance (for testing).
 */
export function resetChatGateway(): void {
  chatGatewayInstance = null;
}

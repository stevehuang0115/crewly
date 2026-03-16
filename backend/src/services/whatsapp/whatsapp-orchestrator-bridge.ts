/**
 * WhatsApp-Orchestrator Bridge
 *
 * Routes messages between WhatsApp and the Crewly orchestrator,
 * enabling mobile control of AI teams via WhatsApp.
 *
 * @module services/whatsapp/bridge
 */

import { EventEmitter } from 'events';
import { getWhatsAppService, WhatsAppService } from './whatsapp.service.js';
import { getChatService, ChatService } from '../chat/chat.service.js';
import {
  isOrchestratorActive,
  isAgentActive,
  getOrchestratorOfflineMessage,
} from '../orchestrator/index.js';
import type {
  WhatsAppIncomingMessage,
  WhatsAppConversationContext,
} from '../../types/whatsapp.types.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { ORCHESTRATOR_SESSION_NAME, MESSAGE_QUEUE_CONSTANTS, WHATSAPP_CONSTANTS, AUDITOR_SCHEDULER_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/**
 * Bridge configuration
 */
export interface WhatsAppBridgeConfig {
  /** Orchestrator session name */
  orchestratorSession: string;
  /** Maximum response length before truncation */
  maxResponseLength: number;
  /** Response timeout in ms */
  responseTimeoutMs: number;
}

/**
 * Default bridge configuration
 */
const DEFAULT_CONFIG: WhatsAppBridgeConfig = {
  orchestratorSession: ORCHESTRATOR_SESSION_NAME,
  maxResponseLength: WHATSAPP_CONSTANTS.MAX_RESPONSE_LENGTH,
  responseTimeoutMs: (MESSAGE_QUEUE_CONSTANTS?.DEFAULT_MESSAGE_TIMEOUT ?? WHATSAPP_CONSTANTS.DEFAULT_FALLBACK_TIMEOUT_MS) + WHATSAPP_CONSTANTS.RESPONSE_TIMEOUT_BUFFER_MS,
};

/** WhatsApp bridge singleton */
let bridgeInstance: WhatsAppOrchestratorBridge | null = null;

/**
 * WhatsAppOrchestratorBridge class
 *
 * Routes messages between WhatsApp and the Crewly orchestrator.
 * Mirrors the SlackOrchestratorBridge pattern with WhatsApp-specific handling.
 *
 * @example
 * ```typescript
 * const bridge = getWhatsAppOrchestratorBridge();
 * await bridge.initialize();
 * ```
 */
export class WhatsAppOrchestratorBridge extends EventEmitter {
  private logger = LoggerService.getInstance().createComponentLogger('WhatsAppBridge');
  private whatsappService: WhatsAppService;
  private chatService: ChatService;
  private messageQueueService: MessageQueueService | null = null;
  private config: WhatsAppBridgeConfig;
  private initialized = false;
  private boundMessageHandler: ((message: WhatsAppIncomingMessage) => Promise<void>) | null = null;

  /**
   * Create a new WhatsAppOrchestratorBridge
   *
   * @param config - Partial configuration to override defaults
   */
  constructor(config: Partial<WhatsAppBridgeConfig> = {}) {
    super();
    this.whatsappService = getWhatsAppService();
    this.chatService = getChatService();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the bridge.
   * Sets up message listeners for WhatsApp incoming messages.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.boundMessageHandler = this.handleWhatsAppMessage.bind(this);
    this.whatsappService.on('message', this.boundMessageHandler);

    this.initialized = true;
    this.logger.info('Initialized');
  }

  /**
   * Check if bridge is initialized
   *
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Set the message queue service for enqueuing messages to the orchestrator.
   *
   * @param service - The MessageQueueService instance
   */
  setMessageQueueService(service: MessageQueueService): void {
    this.messageQueueService = service;
  }

  /**
   * Get current configuration
   *
   * @returns A copy of the current configuration
   */
  getConfig(): WhatsAppBridgeConfig {
    return { ...this.config };
  }

  /**
   * Handle incoming WhatsApp message.
   * Routes the message to the orchestrator and sends the response back.
   *
   * @param message - Incoming WhatsApp message
   */
  private async handleWhatsAppMessage(message: WhatsAppIncomingMessage): Promise<void> {
    this.logger.info('Received message', {
      from: message.contactName || message.from,
      preview: message.text.substring(0, 50),
    });

    try {
      const context = this.whatsappService.getConversationContext(
        message.chatId,
        message.contactName || message.from,
      );

      const response = await this.sendToOrchestrator(message.text, context);

      await this.sendWhatsAppResponse(message.chatId, response);

      this.emit('message_handled', { message, response });
    } catch (error) {
      this.logger.error('Error handling message', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.sendWhatsAppResponse(
          message.chatId,
          `Sorry, I encountered an error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // Silent fail on error response
      }
      this.emit('error', error);
    }
  }

  /**
   * Send message to orchestrator via the message queue and wait for response.
   *
   * @param message - Message text to send
   * @param context - Conversation context
   * @returns Orchestrator response or offline/error message
   */
  private async sendToOrchestrator(
    message: string,
    context?: WhatsAppConversationContext,
  ): Promise<string> {
    try {
      const isActive = await isOrchestratorActive();
      if (!isActive) {
        // Fallback: route to Auditor agent if it's active
        const auditorSession = AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME;
        const auditorActive = await isAgentActive(auditorSession);
        if (auditorActive) {
          this.logger.info('Orchestrator offline — routing message to Auditor agent');
          return this.sendToAuditorFallback(message, context);
        }
        this.logger.info('Orchestrator is not active, returning offline message');
        return getOrchestratorOfflineMessage(true);
      }

      // Capture reference to avoid race condition with non-null assertion
      const mqService = this.messageQueueService;
      if (!mqService) {
        this.logger.error('Message queue service not configured');
        return 'The WhatsApp bridge is not properly configured. Please restart the server.';
      }

      // Store message in chat service
      const result = await this.chatService.sendMessage({
        content: message,
        conversationId: context?.conversationId,
        metadata: {
          source: 'whatsapp',
          chatId: context?.chatId,
          contactName: context?.contactName,
        },
      });

      // Enqueue with a resolve callback for response routing
      const response = await new Promise<string>((resolve) => {
        const timeoutId = setTimeout(() => {
          resolve('The orchestrator is still processing your request. It will reply when ready — no need to resend.');
        }, this.config.responseTimeoutMs);

        try {
          mqService.enqueue({
            content: message,
            conversationId: result.conversation.id,
            source: 'whatsapp',
            sourceMetadata: {
              whatsappResolve: (resp: string) => {
                clearTimeout(timeoutId);
                resolve(resp);
              },
              chatId: context?.chatId,
              contactName: context?.contactName,
            },
          });
        } catch (enqueueErr) {
          clearTimeout(timeoutId);
          resolve(`Failed to enqueue message: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`);
        }
      });

      return response;
    } catch (error) {
      this.logger.error('Error sending to orchestrator', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Route a message to the Auditor agent as a fallback when the orchestrator is offline.
   *
   * Enqueues the message targeting the Auditor's session so the queue processor
   * delivers it to the Auditor PTY. Includes source context for the Auditor.
   *
   * @param message - Original user message
   * @param context - WhatsApp conversation context
   * @returns Acknowledgement message to the user
   */
  private async sendToAuditorFallback(
    message: string,
    context?: WhatsAppConversationContext,
  ): Promise<string> {
    const auditorSession = AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME;
    const enrichedMessage = `[FALLBACK] Orchestrator is offline. WhatsApp message from ${context?.contactName || 'unknown'}:\n${message}`;

    const mqService = this.messageQueueService;
    if (mqService) {
      try {
        const result = await this.chatService.sendMessage({
          content: enrichedMessage,
          conversationId: context?.conversationId,
          metadata: {
            source: 'whatsapp',
            chatId: context?.chatId,
            contactName: context?.contactName,
          },
        });

        mqService.enqueue({
          content: enrichedMessage,
          conversationId: result.conversation.id,
          source: 'whatsapp',
          targetSession: auditorSession,
          sourceMetadata: {
            whatsappResolve: undefined,
            chatId: context?.chatId,
            contactName: context?.contactName,
          },
        });

        this.logger.info('Message routed to Auditor agent via queue', { auditorSession });
        return 'The orchestrator is currently offline. Your message has been forwarded to the Auditor agent.';
      } catch (err) {
        this.logger.error('Failed to route message to Auditor via queue', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return getOrchestratorOfflineMessage(true);
  }

  /**
   * Cleanup bridge resources.
   * Removes only this bridge's event listener and resets initialization state.
   */
  cleanup(): void {
    if (this.boundMessageHandler) {
      this.whatsappService.removeListener('message', this.boundMessageHandler);
      this.boundMessageHandler = null;
    }
    this.initialized = false;
  }

  /**
   * Send a text response back to a WhatsApp chat.
   *
   * @param chatId - Destination chat JID
   * @param text - Response text
   */
  async sendWhatsAppResponse(chatId: string, text: string): Promise<void> {
    const trimmed = text?.trim();
    if (!trimmed) return;

    try {
      await this.whatsappService.sendMessage({ to: chatId, text: trimmed });
    } catch (err) {
      this.logger.error('Failed to send WhatsApp response', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Get WhatsApp bridge singleton
 *
 * @returns WhatsAppOrchestratorBridge instance
 */
export function getWhatsAppOrchestratorBridge(): WhatsAppOrchestratorBridge {
  if (!bridgeInstance) {
    bridgeInstance = new WhatsAppOrchestratorBridge();
  }
  return bridgeInstance;
}

/**
 * Reset WhatsApp bridge singleton (for testing)
 */
export function resetWhatsAppOrchestratorBridge(): void {
  bridgeInstance = null;
}

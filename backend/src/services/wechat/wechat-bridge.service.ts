/**
 * WeChat Orchestrator Bridge
 *
 * Routes incoming WeChat messages to the orchestrator message queue
 * and sends orchestrator replies back via WeChat.
 *
 * Similar to SlackOrchestratorBridge but for the WeChat iLink Bot channel.
 *
 * @module services/wechat/wechat-bridge.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getWeChatService, type WeChatMessage } from './wechat.service.js';

/** Minimal interface for MessageQueueService to avoid circular imports. */
interface IMessageQueueServiceLike {
  enqueue(input: {
    content: string;
    conversationId: string;
    source: 'wechat';
    sourceMetadata?: Record<string, string>;
  }): unknown;
}

/**
 * Bridge between WeChat messages and the orchestrator.
 *
 * Listens for 'message' events from WeChatService and enqueues them
 * into the orchestrator message queue. Stores context_token per
 * conversation so replies can be routed back through WeChat.
 */
export class WeChatBridge {
  private static instance: WeChatBridge | null = null;
  private readonly logger: ComponentLogger;
  private messageQueue: IMessageQueueServiceLike | null = null;
  private contextTokens: Map<string, string> = new Map();
  private initialized = false;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WeChatBridge');
  }

  /**
   * Get the singleton instance.
   *
   * @returns WeChatBridge instance
   */
  static getInstance(): WeChatBridge {
    if (!WeChatBridge.instance) {
      WeChatBridge.instance = new WeChatBridge();
    }
    return WeChatBridge.instance;
  }

  /**
   * Initialize the bridge with the message queue service.
   *
   * @param messageQueue - The orchestrator message queue for enqueuing messages
   */
  initialize(messageQueue: IMessageQueueServiceLike): void {
    if (this.initialized) return;

    this.messageQueue = messageQueue;

    const wechat = getWeChatService();
    wechat.on('message', (msg: WeChatMessage) => this.handleIncomingMessage(msg));
    wechat.on('disconnected', () => {
      this.logger.info('WeChat disconnected — bridge paused');
      this.contextTokens.clear();
    });

    this.initialized = true;
    this.logger.info('WeChat bridge initialized');
  }

  /**
   * Send a reply back to WeChat using the stored context token.
   *
   * @param conversationId - The conversation ID to reply to
   * @param text - Reply text
   * @returns True if sent successfully
   */
  async sendReply(conversationId: string, text: string): Promise<boolean> {
    const contextToken = this.contextTokens.get(conversationId);
    if (!contextToken) {
      this.logger.warn('No context token for WeChat reply', { conversationId });
      return false;
    }

    try {
      const wechat = getWeChatService();
      await wechat.sendMessage(text, contextToken);
      return true;
    } catch (err) {
      this.logger.error('Failed to send WeChat reply', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Get the stored context token for a conversation.
   *
   * @param conversationId - Conversation ID
   * @returns Context token or undefined
   */
  getContextToken(conversationId: string): string | undefined {
    return this.contextTokens.get(conversationId);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming WeChat message by enqueuing it for the orchestrator.
   *
   * @param msg - Incoming WeChat message
   */
  private handleIncomingMessage(msg: WeChatMessage): void {
    if (!this.messageQueue) {
      this.logger.warn('Message queue not available, dropping WeChat message');
      return;
    }

    // Skip non-text messages
    if (msg.msg_type !== 'text') {
      this.logger.debug('Skipping non-text WeChat message', { msgType: msg.msg_type });
      return;
    }

    // Store context token for reply routing
    const conversationId = `wechat-${msg.from_user}`;
    this.contextTokens.set(conversationId, msg.context_token);

    // Enqueue for orchestrator processing
    this.messageQueue.enqueue({
      content: msg.content,
      conversationId,
      source: 'wechat',
      sourceMetadata: {
        fromUser: msg.from_user,
        fromUserName: msg.from_user_name,
        msgId: msg.msg_id,
        contextToken: msg.context_token,
      },
    });

    this.logger.info('WeChat message enqueued for orchestrator', {
      from: msg.from_user_name,
      conversationId,
      contentLength: msg.content.length,
    });
  }
}

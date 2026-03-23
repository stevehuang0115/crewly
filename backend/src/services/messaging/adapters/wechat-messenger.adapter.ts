/**
 * WeChat Messenger Adapter
 *
 * Implements the MessengerAdapter interface for the WeChat iLink Bot.
 * Delegates to WeChatService for actual operations.
 *
 * @module services/messaging/adapters/wechat-messenger.adapter
 */

import { getWeChatService } from '../../wechat/wechat.service.js';
import { WeChatBridge } from '../../wechat/wechat-bridge.service.js';
import type { MessengerAdapter, MessengerPlatform, SendOptions } from '../messenger-adapter.interface.js';

/**
 * Messenger adapter for WeChat using the iLink Bot API.
 */
export class WeChatMessengerAdapter implements MessengerAdapter {
  readonly platform = 'wechat' as MessengerPlatform;

  /**
   * Initialize the adapter by restoring persisted WeChat connection.
   *
   * @param config - Configuration (unused — token loaded from disk)
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const service = getWeChatService();
    await service.tryRestore();
  }

  /**
   * Send a text message via WeChat.
   *
   * Uses the WeChatBridge to find the context token for the channel
   * (conversation ID) and send the reply.
   *
   * @param channel - Conversation ID (e.g., "wechat-user123")
   * @param text - Message content
   * @param _options - Send options (unused for WeChat)
   */
  async sendMessage(channel: string, text: string, _options?: SendOptions): Promise<void> {
    const bridge = WeChatBridge.getInstance();
    const contextToken = bridge.getContextToken(channel);

    if (!contextToken) {
      throw new Error(`No WeChat context token for channel: ${channel}`);
    }

    const service = getWeChatService();
    await service.sendMessage(text, contextToken);
  }

  /**
   * Get the current connection status.
   *
   * @returns Status object with connection state
   */
  getStatus(): { connected: boolean; platform: MessengerPlatform; details?: Record<string, unknown> } {
    const service = getWeChatService();
    const status = service.getStatus();

    return {
      connected: service.isConnected(),
      platform: this.platform,
      details: {
        state: status.state,
        botName: status.botName,
      },
    };
  }

  /**
   * Disconnect the WeChat service.
   */
  async disconnect(): Promise<void> {
    const service = getWeChatService();
    service.disconnect();
  }
}

import { getTelegramService } from '../../telegram/telegram.service.js';
import { MessengerAdapter, MessengerPlatform, SendOptions } from '../messenger-adapter.interface.js';

/**
 * Messenger adapter for Telegram using the Bot API.
 * Delegates to TelegramService for actual operations.
 */
export class TelegramMessengerAdapter implements MessengerAdapter {
  readonly platform: MessengerPlatform = 'telegram';

  /**
   * Initialize the adapter by delegating to TelegramService.
   *
   * @param config - Must contain a `token` string property (mapped to botToken)
   * @throws Error if token is missing or validation fails
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const token = config.token as string | undefined;
    if (!token) {
      throw new Error('Telegram token is required');
    }

    const telegramService = getTelegramService();
    await telegramService.initialize({ botToken: token });
    telegramService.startPolling();
  }

  /**
   * Send a text message to a Telegram chat.
   *
   * @param channel - Telegram chat ID
   * @param text - Message content
   * @param options - Optional send options (threadId for reply)
   * @throws Error if service is not connected or send fails
   */
  async sendMessage(channel: string, text: string, options?: SendOptions): Promise<void> {
    const telegramService = getTelegramService();
    if (!telegramService.isConnected()) {
      throw new Error('Telegram is not connected');
    }
    const replyToId = options?.threadId ? parseInt(options.threadId, 10) : undefined;
    await telegramService.sendMessage(channel, text, replyToId);
  }

  /**
   * Get the current connection status.
   *
   * @returns Status object with connection state and bot details
   */
  getStatus(): { connected: boolean; platform: MessengerPlatform; details?: Record<string, unknown> } {
    const telegramService = getTelegramService();
    return {
      connected: telegramService.isConnected(),
      platform: this.platform,
      details: telegramService.getStatus(),
    };
  }

  /**
   * Disconnect the Telegram service.
   */
  async disconnect(): Promise<void> {
    const telegramService = getTelegramService();
    await telegramService.disconnect();
  }
}

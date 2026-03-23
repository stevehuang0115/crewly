/**
 * Supported messenger platforms.
 */
export type MessengerPlatform = 'slack' | 'telegram' | 'discord' | 'google-chat' | 'wechat';

/**
 * A message received from any messenger platform.
 */
export interface IncomingMessage {
  /** The platform the message originated from */
  platform: MessengerPlatform;
  /** Platform-specific conversation identifier */
  conversationId: string;
  /** Platform-specific channel identifier */
  channelId: string;
  /** Sender identifier (optional) */
  userId?: string;
  /** The message text */
  text: string;
  /** Platform-specific thread/reply identifier (e.g. Slack threadTs, Telegram replyToId) */
  threadId?: string;
  /** Platform-specific message resource name (e.g., Google Chat "spaces/xxx/messages/yyy") */
  messageName?: string;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/**
 * Options when sending a message through an adapter.
 */
export interface SendOptions {
  /** Thread/reply identifier to respond within a thread */
  threadId?: string;
}

/**
 * A platform-specific messenger adapter that can initialize, send messages,
 * report its status, and disconnect.
 */
export interface MessengerAdapter {
  /** The platform this adapter handles */
  readonly platform: MessengerPlatform;
  /** Initialize the adapter with platform-specific configuration */
  initialize(config: Record<string, unknown>): Promise<void>;
  /** Send a text message to the specified channel */
  sendMessage(channel: string, text: string, options?: SendOptions): Promise<void>;
  /** Get the current connection status */
  getStatus(): { connected: boolean; platform: MessengerPlatform; details?: Record<string, unknown> };
  /** Disconnect and clean up resources */
  disconnect(): Promise<void>;
}

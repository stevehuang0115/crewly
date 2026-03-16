/**
 * Google Chat Messenger Adapter
 *
 * Messenger adapter for Google Chat supporting three connection modes:
 * 1. **Webhook mode** — post messages via an incoming webhook URL (send-only)
 * 2. **Service account mode** — send messages via the Chat API (send-only)
 * 3. **Pub/Sub mode** — pull incoming messages from a Cloud Pub/Sub subscription
 *    and reply via the Chat API (bidirectional, thread-aware)
 *
 * In Pub/Sub mode, a Google Chat App is configured to publish events to a
 * Pub/Sub topic. Crewly pulls from the subscription, processes MESSAGE events,
 * and replies in the same thread via the Chat API.
 *
 * @module services/messaging/adapters/google-chat-messenger.adapter
 */

import { MessengerAdapter, MessengerPlatform, IncomingMessage } from '../messenger-adapter.interface.js';
import { GOOGLE_CHAT_PUBSUB_CONSTANTS } from '../../../constants.js';
import { LoggerService } from '../../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleChatPubSub');

/** Connection mode for the adapter */
type GoogleChatMode = 'webhook' | 'service-account' | 'pubsub' | 'none';

/** Authentication mode — how OAuth2 tokens are obtained */
export type GoogleChatAuthMode = 'service_account' | 'adc';

/**
 * ADC (Application Default Credentials) JSON file shape.
 * Created by `gcloud auth application-default login`.
 */
interface AdcCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: string;
}

/**
 * Shape of a Google Chat message (shared between legacy and v2 formats).
 */
interface ChatMessage {
  name?: string;
  text?: string;
  thread?: { name?: string };
  sender?: { name?: string; displayName?: string };
  createTime?: string;
}

/**
 * Shape of a Google Chat event delivered via Pub/Sub.
 *
 * Supports two formats:
 * - **Legacy (v1)**: `{ type: 'MESSAGE', message: {...}, space: {...} }`
 * - **v2 (Apps Script / Chat API v2)**: `{ commonEventObject: {...}, chat: { messagePayload: { message: {...}, space: {...} } } }`
 */
interface ChatEventPayload {
  /** Legacy format: event type (MESSAGE, ADDED_TO_SPACE, etc.) */
  type?: string;
  eventTime?: string;
  /** Legacy format: space info at top level */
  space?: { name?: string; displayName?: string };
  /** Legacy format: message info at top level */
  message?: ChatMessage;
  /** v2 format: common event metadata */
  commonEventObject?: { hostApp?: string; platform?: string };
  /** v2 format: chat-specific payload */
  chat?: {
    messagePayload?: {
      message?: ChatMessage;
      space?: { name?: string; displayName?: string };
    };
  };
}

/**
 * Shape of a single received Pub/Sub message from the pull response.
 */
interface PubSubReceivedMessage {
  ackId: string;
  message: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
}

/**
 * Callback type for incoming messages from Pub/Sub pull.
 */
export type GoogleChatIncomingCallback = (msg: IncomingMessage) => void;

/**
 * Messenger adapter for Google Chat with Pub/Sub support.
 *
 * Supports webhook, service-account, and pubsub modes.
 * Pub/Sub mode enables bidirectional communication with thread tracking.
 */
export class GoogleChatMessengerAdapter implements MessengerAdapter {
  readonly platform: MessengerPlatform = 'google-chat';

  /** Current connection mode */
  private mode: GoogleChatMode = 'none';

  /** Webhook URL for posting messages (webhook mode) */
  private webhookUrl: string | null = null;

  /** Service account key JSON string */
  private serviceAccountKey: string | null = null;

  /** Authentication mode: service_account (JWT) or adc (refresh token) */
  private authMode: GoogleChatAuthMode = 'service_account';

  /** ADC credentials (parsed from application_default_credentials.json) */
  private adcCredentials: AdcCredentials | null = null;

  /** Access token obtained from service account or ADC (cached) */
  private accessToken: string | null = null;

  /** Access token expiry timestamp */
  private tokenExpiresAt = 0;

  /** OAuth2 scopes for the current mode */
  private tokenScopes: string = GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE;

  /** Pending token refresh promise to deduplicate concurrent requests (RL2) */
  private pendingTokenRefresh: Promise<string> | null = null;

  /** Full Pub/Sub subscription resource name (e.g. projects/PROJECT/subscriptions/SUB) */
  private subscriptionName: string | null = null;

  /** GCP project ID (for Pub/Sub mode) */
  private projectId: string | null = null;

  /** Pub/Sub pull interval timer */
  private pullIntervalTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback for incoming messages */
  private onIncomingMessage: GoogleChatIncomingCallback | null = null;

  /** Service account email for impersonation (ADC mode) */
  private serviceAccountEmail: string | null = null;

  /** Impersonated SA token (separate from user ADC token) */
  private saAccessToken: string | null = null;

  /** Impersonated SA token expiry timestamp */
  private saTokenExpiresAt = 0;

  /**
   * Recent send deduplication cache.
   * Key: `${space}:${threadId}:${contentPrefix}`, value: timestamp (epoch ms).
   * Prevents the same message being sent twice within DEDUP_WINDOW_MS (e.g. when
   * both the auto-route and a manual reply-gchat call fire for the same response).
   */
  private recentSends = new Map<string, number>();

  /** Deduplication window in milliseconds */
  private static readonly DEDUP_WINDOW_MS = 10_000;

  /** Consecutive pull failure count */
  private consecutiveFailures = 0;

  /** Whether the pull loop is paused due to failures */
  private pullPaused = false;

  /** Timestamp of the last successful pull (epoch ms) */
  private lastPullAt: number | null = null;

  /**
   * Initialize the adapter with the provided credentials.
   *
   * Detects mode based on provided config fields:
   * - `webhookUrl` → webhook mode
   * - `serviceAccountKey` + `projectId` + `subscriptionName` → pubsub mode
   * - `serviceAccountKey` alone → service-account mode
   *
   * @param config - Configuration object with credentials
   * @throws Error if credentials are invalid or missing
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const webhookUrl = config.webhookUrl;
    const serviceAccountKey = config.serviceAccountKey;
    const projectId = config.projectId;
    const subscriptionName = config.subscriptionName;
    const onIncomingMessage = config.onIncomingMessage;
    const authMode = (config.authMode === 'adc' ? 'adc' : 'service_account') as GoogleChatAuthMode;

    // Webhook mode
    if (typeof webhookUrl === 'string' && webhookUrl) {
      if (!webhookUrl.startsWith('https://chat.googleapis.com/')) {
        throw new Error('Invalid Google Chat webhook URL. Must start with https://chat.googleapis.com/');
      }
      this.resetState();
      this.webhookUrl = webhookUrl;
      this.mode = 'webhook';
      return;
    }

    // ADC mode — use Application Default Credentials (no SA key needed)
    if (authMode === 'adc') {
      const adcCreds = await this.loadAdcCredentials();
      this.resetState();
      this.authMode = 'adc';
      this.adcCredentials = adcCreds;

      // Store optional SA email for impersonation
      if (typeof config.serviceAccountEmail === 'string' && config.serviceAccountEmail) {
        this.serviceAccountEmail = config.serviceAccountEmail;
      }

      // Pub/Sub mode: requires projectId + subscriptionName
      if (typeof projectId === 'string' && projectId &&
          typeof subscriptionName === 'string' && subscriptionName) {
        this.projectId = projectId;
        this.subscriptionName = `projects/${projectId}/subscriptions/${subscriptionName}`;
        this.tokenScopes = `${GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE} ${GOOGLE_CHAT_PUBSUB_CONSTANTS.PUBSUB_SCOPE}`;
        this.mode = 'pubsub';

        if (typeof onIncomingMessage === 'function') {
          this.onIncomingMessage = onIncomingMessage as GoogleChatIncomingCallback;
        }

        this.startPubSubPull();
        return;
      }

      // Service account mode with ADC auth (send-only)
      this.mode = 'service-account';
      this.tokenScopes = GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE;
      return;
    }

    // Service Account mode — requires a service account key
    if (typeof serviceAccountKey === 'string' && serviceAccountKey) {
      this.validateServiceAccountKey(serviceAccountKey);

      this.resetState();
      this.authMode = 'service_account';
      this.serviceAccountKey = serviceAccountKey;

      // Pub/Sub mode: requires projectId + subscriptionName
      if (typeof projectId === 'string' && projectId &&
          typeof subscriptionName === 'string' && subscriptionName) {
        this.projectId = projectId;
        this.subscriptionName = `projects/${projectId}/subscriptions/${subscriptionName}`;
        this.tokenScopes = `${GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE} ${GOOGLE_CHAT_PUBSUB_CONSTANTS.PUBSUB_SCOPE}`;
        this.mode = 'pubsub';

        if (typeof onIncomingMessage === 'function') {
          this.onIncomingMessage = onIncomingMessage as GoogleChatIncomingCallback;
        }

        this.startPubSubPull();
        return;
      }

      // Service account mode (send-only)
      this.mode = 'service-account';
      this.tokenScopes = GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE;
      return;
    }

    throw new Error('Google Chat requires either a webhookUrl, serviceAccountKey, or authMode: adc');
  }

  /**
   * Send a text message to a Google Chat space.
   *
   * In webhook mode, the `channel` parameter is ignored (webhook URL determines the space).
   * In service-account/pubsub mode, `channel` is the space name (e.g., "spaces/AAAA...").
   *
   * @param channel - Google Chat space name (used in service-account/pubsub mode)
   * @param text - Message content
   * @param options - Optional send options (threadId for threaded replies)
   * @throws Error if adapter is not initialized or send fails
   */
  async sendMessage(channel: string, text: string, options?: { threadId?: string }): Promise<void> {
    // Dedup: skip if the same message was sent to the same space+thread recently.
    // This prevents double-sends when both the auto-route (googleChatResolve) and
    // a manual reply-gchat API call fire for the same response.
    const dedupKey = `${channel}:${options?.threadId || ''}:${text.substring(0, 200)}`;
    const now = Date.now();
    const lastSent = this.recentSends.get(dedupKey);
    if (lastSent && (now - lastSent) < GoogleChatMessengerAdapter.DEDUP_WINDOW_MS) {
      logger.info('Skipping duplicate send (same message sent within dedup window)', {
        channel,
        threadId: options?.threadId,
        windowMs: GoogleChatMessengerAdapter.DEDUP_WINDOW_MS,
      });
      return;
    }
    this.recentSends.set(dedupKey, now);
    // Evict stale entries to prevent unbounded growth
    for (const [key, ts] of this.recentSends) {
      if (now - ts > GoogleChatMessengerAdapter.DEDUP_WINDOW_MS) {
        this.recentSends.delete(key);
      }
    }

    if (this.mode === 'webhook' && this.webhookUrl) {
      await this.sendViaWebhook(text, options?.threadId);
      return;
    }

    if ((this.mode === 'service-account' || this.mode === 'pubsub') &&
        (this.serviceAccountKey || this.adcCredentials)) {
      await this.sendViaApi(channel, text, options?.threadId);
      return;
    }

    throw new Error('Google Chat adapter is not initialized');
  }

  /**
   * Get the current connection status.
   *
   * @returns Status object with connected flag, platform, and mode details
   */
  getStatus(): { connected: boolean; platform: MessengerPlatform; details?: Record<string, unknown> } {
    return {
      connected: this.mode !== 'none',
      platform: this.platform,
      details: {
        mode: this.mode,
        authMode: this.authMode,
        ...(this.serviceAccountEmail ? { serviceAccountEmail: this.serviceAccountEmail } : {}),
        ...(this.mode === 'pubsub' ? {
          subscriptionName: this.subscriptionName,
          projectId: this.projectId,
          pullActive: Boolean(this.pullIntervalTimer) && !this.pullPaused,
          pullPaused: this.pullPaused,
          consecutiveFailures: this.consecutiveFailures,
          lastPullAt: this.lastPullAt ? new Date(this.lastPullAt).toISOString() : null,
        } : {}),
      },
    };
  }

  /**
   * Disconnect by clearing stored credentials and stopping the pull loop.
   */
  async disconnect(): Promise<void> {
    this.stopPubSubPull();
    this.resetState();
  }

  /**
   * Add an emoji reaction to a Google Chat message.
   *
   * Only works in service-account/pubsub mode — webhook mode does not support the
   * reactions API. Calls `spaces.messages.reactions.create`.
   *
   * @param messageName - Full message resource name (e.g., "spaces/xxx/messages/yyy")
   * @param emoji - Unicode emoji character (e.g., "👀", "✅")
   */
  async addReaction(messageName: string, emoji: string): Promise<void> {
    if (!this.serviceAccountKey && !this.adcCredentials) {
      // Reactions require service account or ADC mode — silently skip in webhook mode
      return;
    }

    if (!messageName || !messageName.includes('/messages/')) {
      return;
    }

    const token = await this.getAccessToken();

    const resp = await fetch(
      `${GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_API_BASE}/${messageName}/reactions`,
      {
        method: 'POST',
        headers: this.getAuthHeaders(token),
        body: JSON.stringify({
          emoji: { unicode: emoji },
        }),
        signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
      }
    );

    if (!resp.ok) {
      const details = await resp.text();
      // Non-critical — don't throw for duplicates
      if (!details.includes('ALREADY_EXISTS')) {
        throw new Error(`Google Chat reaction failed (${resp.status}): ${details}`);
      }
    }
  }

  // ===========================================================================
  // Pub/Sub Pull Loop
  // ===========================================================================

  /**
   * Start the Pub/Sub pull loop that periodically fetches messages.
   */
  private startPubSubPull(): void {
    this.stopPubSubPull();
    this.consecutiveFailures = 0;
    this.pullPaused = false;

    logger.info('Starting Pub/Sub pull loop', {
      subscription: this.subscriptionName,
      intervalMs: GOOGLE_CHAT_PUBSUB_CONSTANTS.PULL_INTERVAL_MS,
      maxFailures: GOOGLE_CHAT_PUBSUB_CONSTANTS.MAX_CONSECUTIVE_FAILURES,
    });

    this.pullIntervalTimer = setInterval(async () => {
      if (this.pullPaused) return;
      try {
        await this.pullMessages();
        this.consecutiveFailures = 0;
      } catch (error) {
        // AbortError / TimeoutError from AbortSignal.timeout() is a normal
        // "no messages within the timeout window" — not a real failure.
        const isTimeout = error instanceof DOMException && (
          error.name === 'AbortError' || error.name === 'TimeoutError'
        );
        if (isTimeout) {
          // Normal timeout — reset failure counter and skip error handling
          this.consecutiveFailures = 0;
          logger.debug('Pull timed out (no messages)', { subscription: this.subscriptionName });
          return;
        }

        this.consecutiveFailures++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Pull loop failure', {
          subscription: this.subscriptionName,
          consecutiveFailures: this.consecutiveFailures,
          error: errorMsg,
        });
        if (this.consecutiveFailures >= GOOGLE_CHAT_PUBSUB_CONSTANTS.MAX_CONSECUTIVE_FAILURES) {
          this.pullPaused = true;
          logger.error('Pull loop PAUSED due to repeated failures', {
            subscription: this.subscriptionName,
            consecutiveFailures: this.consecutiveFailures,
          });
        }
      }
    }, GOOGLE_CHAT_PUBSUB_CONSTANTS.PULL_INTERVAL_MS);
  }

  /**
   * Stop the Pub/Sub pull loop.
   */
  private stopPubSubPull(): void {
    if (this.pullIntervalTimer) {
      logger.info('Stopping Pub/Sub pull loop', { subscription: this.subscriptionName });
      clearInterval(this.pullIntervalTimer);
      this.pullIntervalTimer = null;
    }
  }

  /**
   * Pull messages from the Pub/Sub subscription, process them, and acknowledge.
   *
   * Each message is a base64-encoded Google Chat event JSON. Only MESSAGE-type
   * events are forwarded to the incoming message callback. All messages are
   * acknowledged regardless of type to prevent redelivery.
   */
  async pullMessages(): Promise<number> {
    if (!this.subscriptionName) {
      throw new Error('Pub/Sub subscription not configured');
    }

    logger.debug('Pulling messages', { subscription: this.subscriptionName });

    const token = await this.getAccessToken();
    const pullUrl = `${GOOGLE_CHAT_PUBSUB_CONSTANTS.PUBSUB_API_BASE}/${this.subscriptionName}:pull`;

    const resp = await fetch(pullUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(token),
      body: JSON.stringify({
        maxMessages: GOOGLE_CHAT_PUBSUB_CONSTANTS.MAX_MESSAGES_PER_PULL,
        returnImmediately: true,
      }),
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Pub/Sub pull failed (${resp.status}): ${details}`);
    }

    const data = await resp.json() as { receivedMessages?: PubSubReceivedMessage[] };
    this.lastPullAt = Date.now();

    if (!data.receivedMessages || data.receivedMessages.length === 0) {
      return 0;
    }

    const messageCount = data.receivedMessages.length;
    const receivedAt = new Date().toISOString();
    logger.info('Received messages from Pub/Sub', {
      count: messageCount,
      subscription: this.subscriptionName,
      receivedAt,
    });

    const ackIds: string[] = [];

    for (const received of data.receivedMessages) {
      ackIds.push(received.ackId);

      if (!received.message.data) continue;

      try {
        const decoded = Buffer.from(received.message.data, 'base64').toString('utf-8');
        logger.info('Decoded Pub/Sub payload', {
          messageId: received.message.messageId,
          snippet: decoded.slice(0, 200),
        });
        const event = JSON.parse(decoded) as ChatEventPayload;
        logger.info('Parsed chat event', {
          keys: Object.keys(event),
          type: event.type,
          hasMessage: Boolean(event.message),
          hasText: Boolean(event.message?.text),
          space: event.space?.name,
          // v2 format detection
          hasChat: Boolean(event.chat),
          chatKeys: event.chat ? Object.keys(event.chat) : 'none',
          hasCommonEventObject: Boolean(event.commonEventObject),
        });
        this.processChatEvent(event);
      } catch (err) {
        logger.error('Failed to parse Pub/Sub message', {
          messageId: received.message.messageId,
          error: err instanceof Error ? err.message : String(err),
          dataSnippet: received.message.data?.slice(0, 100),
        });
      }
    }

    // Acknowledge all messages (even non-MESSAGE types) to prevent redelivery
    if (ackIds.length > 0) {
      await this.acknowledgeMessages(ackIds);
    }

    return messageCount;
  }

  /**
   * Process a Google Chat event and forward MESSAGE events to the callback.
   *
   * Supports two payload formats:
   * - **Legacy (v1)**: `{ type: 'MESSAGE', message: { text, sender, thread }, space }`
   * - **v2**: `{ commonEventObject: {...}, chat: { messagePayload: { message: {...}, space: {...} } } }`
   *
   * Both formats are normalized into the same IncomingMessage shape.
   *
   * @param event - Parsed Google Chat event payload (legacy or v2)
   */
  private processChatEvent(event: ChatEventPayload): void {
    // Detect format and extract message + space
    const isV2 = Boolean(event.chat?.messagePayload);
    const msg = isV2 ? event.chat?.messagePayload?.message : event.message;
    const space = isV2 ? event.chat?.messagePayload?.space : event.space;

    // Legacy format: check type field. v2 format: check if messagePayload exists (implies MESSAGE)
    const isMessage = isV2
      ? Boolean(msg?.text)
      : (event.type === 'MESSAGE' && Boolean(msg?.text));

    if (!isMessage || !msg?.text) {
      logger.info('Skipping non-MESSAGE event', {
        format: isV2 ? 'v2' : 'legacy',
        type: event.type,
        hasText: Boolean(msg?.text),
        space: space?.name,
      });
      return;
    }

    if (!this.onIncomingMessage) {
      logger.warn('MESSAGE event received but no onIncomingMessage callback set — message dropped', {
        format: isV2 ? 'v2' : 'legacy',
        space: space?.name,
        textSnippet: msg.text.slice(0, 80),
      });
      return;
    }

    const spaceName = space?.name || '';
    const threadName = msg.thread?.name || '';
    const senderName = msg.sender?.displayName || msg.sender?.name || '';

    logger.info('Processing MESSAGE event', {
      format: isV2 ? 'v2' : 'legacy',
      space: spaceName,
      sender: senderName,
      textLength: msg.text.length,
      thread: threadName ? threadName.slice(-20) : 'none',
    });

    const incomingMessage: IncomingMessage = {
      platform: 'google-chat',
      conversationId: spaceName,
      channelId: spaceName,
      userId: senderName,
      text: msg.text,
      threadId: threadName,
      timestamp: msg.createTime || event.eventTime || new Date().toISOString(),
    };

    this.onIncomingMessage(incomingMessage);
  }

  /**
   * Acknowledge processed messages to prevent redelivery.
   *
   * @param ackIds - Array of ack IDs from the pull response
   */
  private async acknowledgeMessages(ackIds: string[]): Promise<void> {
    if (!this.subscriptionName) return;

    const token = await this.getAccessToken();
    const ackUrl = `${GOOGLE_CHAT_PUBSUB_CONSTANTS.PUBSUB_API_BASE}/${this.subscriptionName}:acknowledge`;

    const resp = await fetch(ackUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(token),
      body: JSON.stringify({ ackIds }),
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Pub/Sub acknowledge failed (${resp.status}): ${details}`);
    }
  }

  // ===========================================================================
  // Send Methods
  // ===========================================================================

  /**
   * Send a message via incoming webhook URL.
   *
   * @param text - Message text
   * @param threadKey - Optional thread key for threaded replies
   */
  private async sendViaWebhook(text: string, threadKey?: string): Promise<void> {
    if (!this.webhookUrl) {
      throw new Error('Webhook URL not configured');
    }

    const body: Record<string, unknown> = { text };
    if (threadKey) {
      body.thread = { threadKey };
    }

    // Append threadKey as query param if provided (Google Chat webhook threading)
    let url = this.webhookUrl;
    if (threadKey) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Google Chat webhook send failed (${resp.status}): ${details}`);
    }
  }

  /**
   * Send a message via the Google Chat REST API using service account credentials.
   *
   * When a threadId (thread name) is provided, the reply is posted to the same
   * thread. This enables conversational thread tracking for Pub/Sub mode.
   *
   * @param space - Space name (e.g., "spaces/AAAA...")
   * @param text - Message text
   * @param threadName - Optional full thread name (e.g., "spaces/SPACE/threads/THREAD")
   */
  private async sendViaApi(space: string, text: string, threadName?: string): Promise<void> {
    if (!this.serviceAccountKey && !this.adcCredentials) {
      throw new Error('No credentials configured (service account key or ADC)');
    }

    if (!space || !space.startsWith('spaces/')) {
      throw new Error('Invalid Google Chat space name. Must start with "spaces/"');
    }

    // Split long messages into chunks that fit within the API limit
    const maxLen = GOOGLE_CHAT_PUBSUB_CONSTANTS.MAX_MESSAGE_LENGTH;
    const chunks = text.length > maxLen
      ? GoogleChatMessengerAdapter.splitMessage(text, maxLen - 96)
      : [text];

    const token = await this.getAccessToken();

    for (const chunk of chunks) {
      const body: Record<string, unknown> = { text: chunk };
      if (threadName) {
        body.thread = { name: threadName };
      }

      let url = `${GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_API_BASE}/${space}/messages`;
      if (threadName) {
        url += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const details = await resp.text();
        throw new Error(`Google Chat API send failed (${resp.status}): ${details}`);
      }
    }
  }

  /**
   * Split a message into chunks that fit within Google Chat's character limit.
   *
   * Splits on double-newline paragraph boundaries when possible. Falls back to
   * single-newline, then hard truncation at maxLength.
   *
   * @param text - The full message text to split
   * @param maxLength - Maximum characters per chunk (default 4000)
   * @returns Array of text chunks, each within maxLength
   */
  static splitMessage(text: string, maxLength = 4000): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split on a double-newline boundary
      let splitIdx = remaining.lastIndexOf('\n\n', maxLength);

      // Fall back to single newline
      if (splitIdx <= 0) {
        splitIdx = remaining.lastIndexOf('\n', maxLength);
      }

      // Hard cut if no newline found
      if (splitIdx <= 0) {
        splitIdx = maxLength;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
    }

    return chunks;
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  /**
   * Get a valid access token, refreshing if needed.
   *
   * Uses JWT-based OAuth2 for service accounts, or refresh_token flow for ADC.
   * The scope includes Pub/Sub when in pubsub mode.
   *
   * @returns Valid access token string
   */
  async getAccessToken(): Promise<string> {
    // When SA impersonation is active, return cached SA token if valid
    if (this.serviceAccountEmail && this.saAccessToken && Date.now() < this.saTokenExpiresAt - 60_000) {
      return this.saAccessToken;
    }

    // Return cached token if still valid (with 60s buffer)
    if (!this.serviceAccountEmail && this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    // Deduplicate concurrent refresh requests (RL2)
    if (this.pendingTokenRefresh) {
      return this.pendingTokenRefresh;
    }

    this.pendingTokenRefresh = this.refreshAccessToken();
    try {
      return await this.pendingTokenRefresh;
    } finally {
      this.pendingTokenRefresh = null;
    }
  }

  /**
   * Perform the actual token refresh.
   *
   * Dispatches to the appropriate flow based on authMode:
   * - `service_account`: JWT-based OAuth2 flow with SA private key
   * - `adc`: Refresh token flow using ADC credentials
   *
   * @returns Fresh access token string
   */
  private async refreshAccessToken(): Promise<string> {
    if (this.authMode === 'adc') {
      return this.refreshAccessTokenViaAdc();
    }
    return this.refreshAccessTokenViaJwt();
  }

  /**
   * Refresh access token via JWT-based OAuth2 flow (service account).
   *
   * @returns Fresh access token string
   */
  private async refreshAccessTokenViaJwt(): Promise<string> {
    if (!this.serviceAccountKey) {
      throw new Error('Service account key not configured');
    }

    const key = JSON.parse(this.serviceAccountKey);
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: this.tokenScopes,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');

    // Sign with private key using Node.js crypto
    const { createSign } = await import('node:crypto');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(key.private_key, 'base64url');

    const jwt = `${header}.${payload}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Google Chat token exchange failed (${resp.status}): ${details}`);
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  /**
   * Refresh access token via ADC (Application Default Credentials).
   *
   * Uses the refresh_token from the ADC JSON file to obtain a new access token
   * from Google's OAuth2 token endpoint. This supports credentials created by
   * `gcloud auth application-default login`.
   *
   * When `serviceAccountEmail` is configured, the ADC user token is used to
   * impersonate the service account via the IAM Credentials API, producing a
   * token with `chat.bot` and `pubsub` scopes that the Chat API accepts.
   *
   * @returns Fresh access token string (impersonated SA token if configured, else user token)
   */
  private async refreshAccessTokenViaAdc(): Promise<string> {
    if (!this.adcCredentials) {
      throw new Error('ADC credentials not loaded');
    }

    const { client_id, client_secret, refresh_token } = this.adcCredentials;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id,
      client_secret,
      refresh_token,
    });

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`ADC token refresh failed (${resp.status}): ${details}`);
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    // If SA impersonation is configured, exchange the user token for an SA token
    if (this.serviceAccountEmail) {
      return this.impersonateServiceAccount(this.accessToken);
    }

    return this.accessToken;
  }

  /**
   * Impersonate a service account using the IAM Credentials API.
   *
   * Uses the user's ADC access token to call `generateAccessToken` on the
   * target service account, producing a token with `chat.bot` and `pubsub`
   * scopes. The user must have the `Service Account Token Creator` IAM role.
   *
   * @param userToken - ADC user access token for authorization
   * @returns Impersonated service account access token
   * @throws Error if impersonation fails (e.g., missing IAM role)
   */
  private async impersonateServiceAccount(userToken: string): Promise<string> {
    // Return cached SA token if still valid (60s buffer)
    if (this.saAccessToken && Date.now() < this.saTokenExpiresAt - 60_000) {
      return this.saAccessToken;
    }

    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${this.serviceAccountEmail}:generateAccessToken`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    };
    if (this.projectId) {
      headers['x-goog-user-project'] = this.projectId;
    }

    const reqBody = {
      scope: [
        GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE,
        GOOGLE_CHAT_PUBSUB_CONSTANTS.PUBSUB_SCOPE,
      ],
      lifetime: '3600s',
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(GOOGLE_CHAT_PUBSUB_CONSTANTS.FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`SA impersonation failed (${resp.status}): ${details}`);
    }

    const result = await resp.json() as { accessToken: string; expireTime: string };
    this.saAccessToken = result.accessToken;
    this.saTokenExpiresAt = new Date(result.expireTime).getTime();

    logger.info('Impersonated service account', {
      serviceAccountEmail: this.serviceAccountEmail,
      expiresAt: result.expireTime,
    });

    return this.saAccessToken;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Build auth headers for Google API requests.
   *
   * When using ADC auth mode, adds x-goog-user-project header to set the
   * billing/quota project. Without this header, ADC requests fail with
   * 403 PERMISSION_DENIED because Google cannot determine which project
   * should be billed for the API usage.
   *
   * @param token - OAuth2 access token
   * @returns Headers object with Authorization, Content-Type, and optional quota project
   */
  private getAuthHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (this.authMode === 'adc' && this.projectId) {
      headers['x-goog-user-project'] = this.projectId;
    }
    return headers;
  }

  /**
   * Validate a service account key JSON string.
   *
   * @param key - JSON string of the service account key
   * @throws Error if the key is invalid
   */
  private validateServiceAccountKey(key: string): void {
    try {
      const parsed = JSON.parse(key);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('Service account key must contain client_email and private_key');
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('Service account key must be valid JSON');
      }
      throw err;
    }
  }

  /**
   * Load ADC (Application Default Credentials) from the filesystem.
   *
   * Checks (in order):
   * 1. `GOOGLE_APPLICATION_CREDENTIALS` environment variable (custom path)
   * 2. Default gcloud ADC path: `~/.config/gcloud/application_default_credentials.json`
   *
   * @returns Parsed ADC credentials
   * @throws Error if the ADC file is not found or invalid
   */
  async loadAdcCredentials(): Promise<AdcCredentials> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const defaultPath = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    const credPath = envPath || defaultPath;

    let raw: string;
    try {
      raw = await readFile(credPath, 'utf-8');
    } catch {
      throw new Error(
        `ADC credentials file not found at ${credPath}. ` +
        'Run: gcloud auth application-default login --scopes=' +
        'https://www.googleapis.com/auth/chat.bot,' +
        'https://www.googleapis.com/auth/pubsub,' +
        'https://www.googleapis.com/auth/cloud-platform'
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('ADC credentials file is not valid JSON');
    }

    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
      throw new Error(
        'ADC credentials file must contain client_id, client_secret, and refresh_token. ' +
        'Ensure you ran gcloud auth application-default login with the correct scopes.'
      );
    }

    return {
      client_id: parsed.client_id as string,
      client_secret: parsed.client_secret as string,
      refresh_token: parsed.refresh_token as string,
      type: (parsed.type as string) || 'authorized_user',
    };
  }

  /**
   * Reset all internal state to defaults.
   */
  private resetState(): void {
    this.stopPubSubPull();
    this.webhookUrl = null;
    this.serviceAccountKey = null;
    this.authMode = 'service_account';
    this.adcCredentials = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.tokenScopes = GOOGLE_CHAT_PUBSUB_CONSTANTS.CHAT_SCOPE;
    this.pendingTokenRefresh = null;
    this.subscriptionName = null;
    this.projectId = null;
    this.serviceAccountEmail = null;
    this.saAccessToken = null;
    this.saTokenExpiresAt = 0;
    this.onIncomingMessage = null;
    this.consecutiveFailures = 0;
    this.pullPaused = false;
    this.lastPullAt = null;
    this.mode = 'none';
  }
}

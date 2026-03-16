/**
 * Google Chat Messenger Adapter
 *
 * Messenger adapter for Google Chat using the Google Chat API (webhook or service account).
 * Supports sending messages to Google Chat spaces via incoming webhooks or
 * the Chat API with a service account.
 *
 * @module services/messaging/adapters/google-chat-messenger.adapter
 */

import { MessengerAdapter, MessengerPlatform } from '../messenger-adapter.interface.js';

/** Timeout for external Google Chat API calls (ms). */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Messenger adapter for Google Chat.
 *
 * Supports two modes:
 * 1. **Webhook mode** (simpler): uses an incoming webhook URL to post messages
 * 2. **Service account mode**: uses a service account key to call the Chat API
 *
 * Webhook mode is used when `webhookUrl` is provided in config.
 * Service account mode is used when `serviceAccountKey` is provided.
 */
export class GoogleChatMessengerAdapter implements MessengerAdapter {
  readonly platform: MessengerPlatform = 'google-chat';

  /** Webhook URL for posting messages (webhook mode) */
  private webhookUrl: string | null = null;

  /** Service account key JSON (service account mode) */
  private serviceAccountKey: string | null = null;

  /** Access token obtained from service account (cached) */
  private accessToken: string | null = null;

  /** Access token expiry timestamp */
  private tokenExpiresAt = 0;

  /**
   * Initialize the adapter by validating credentials.
   *
   * @param config - Must contain either `webhookUrl` string or `serviceAccountKey` string
   * @throws Error if neither credential is provided or validation fails
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const webhookUrl = config.webhookUrl;
    const serviceAccountKey = config.serviceAccountKey;

    if (typeof webhookUrl === 'string' && webhookUrl) {
      // Webhook mode: validate the URL format
      if (!webhookUrl.startsWith('https://chat.googleapis.com/')) {
        throw new Error('Invalid Google Chat webhook URL. Must start with https://chat.googleapis.com/');
      }

      // Validate by sending a test (dry-run) - Google Chat webhooks don't have a validate endpoint,
      // so we just validate the URL format and store it
      this.webhookUrl = webhookUrl;
      this.serviceAccountKey = null;
      this.accessToken = null;
      return;
    }

    if (typeof serviceAccountKey === 'string' && serviceAccountKey) {
      // Service account mode: validate the key is valid JSON
      try {
        const parsed = JSON.parse(serviceAccountKey);
        if (!parsed.client_email || !parsed.private_key) {
          throw new Error('Service account key must contain client_email and private_key');
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error('Service account key must be valid JSON');
        }
        throw err;
      }

      this.serviceAccountKey = serviceAccountKey;
      this.webhookUrl = null;
      this.accessToken = null;
      return;
    }

    throw new Error('Google Chat requires either a webhookUrl or serviceAccountKey');
  }

  /**
   * Send a text message to a Google Chat space.
   *
   * In webhook mode, the `channel` parameter is ignored (webhook URL determines the space).
   * In service account mode, `channel` is the space name (e.g., "spaces/AAAA...").
   *
   * @param channel - Google Chat space name (used in service account mode)
   * @param text - Message content
   * @param options - Optional send options (threadId for threaded replies)
   * @throws Error if adapter is not initialized or send fails
   */
  async sendMessage(channel: string, text: string, options?: { threadId?: string }): Promise<void> {
    if (this.webhookUrl) {
      await this.sendViaWebhook(text, options?.threadId);
      return;
    }

    if (this.serviceAccountKey) {
      await this.sendViaApi(channel, text, options?.threadId);
      return;
    }

    throw new Error('Google Chat adapter is not initialized');
  }

  /**
   * Get the current connection status.
   *
   * @returns Status object with connected flag and platform identifier
   */
  getStatus(): { connected: boolean; platform: MessengerPlatform; details?: Record<string, unknown> } {
    const connected = Boolean(this.webhookUrl || this.serviceAccountKey);
    return {
      connected,
      platform: this.platform,
      details: {
        mode: this.webhookUrl ? 'webhook' : this.serviceAccountKey ? 'service-account' : 'none',
      },
    };
  }

  /**
   * Disconnect by clearing stored credentials.
   */
  async disconnect(): Promise<void> {
    this.webhookUrl = null;
    this.serviceAccountKey = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Add an emoji reaction to a Google Chat message.
   *
   * Only works in service account mode — webhook mode does not support the
   * reactions API. Calls `spaces.messages.reactions.create`.
   *
   * @param messageName - Full message resource name (e.g., "spaces/xxx/messages/yyy")
   * @param emoji - Unicode emoji character (e.g., "👀", "✅")
   */
  async addReaction(messageName: string, emoji: string): Promise<void> {
    if (!this.serviceAccountKey) {
      // Reactions require service account mode — silently skip in webhook mode
      return;
    }

    if (!messageName || !messageName.includes('/messages/')) {
      return;
    }

    const token = await this.getAccessToken();

    const resp = await fetch(
      `https://chat.googleapis.com/v1/${messageName}/reactions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emoji: { unicode: emoji },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (!resp.ok) {
      const details = await resp.text();
      // Non-critical — don't throw, just log
      if (!details.includes('ALREADY_EXISTS')) {
        throw new Error(`Google Chat reaction failed (${resp.status}): ${details}`);
      }
    }
  }

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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Google Chat webhook send failed (${resp.status}): ${details}`);
    }
  }

  /**
   * Send a message via the Google Chat REST API using service account credentials.
   *
   * @param space - Space name (e.g., "spaces/AAAA...")
   * @param text - Message text
   * @param threadKey - Optional thread key for threaded replies
   */
  private async sendViaApi(space: string, text: string, threadKey?: string): Promise<void> {
    if (!this.serviceAccountKey) {
      throw new Error('Service account key not configured');
    }

    if (!space || !space.startsWith('spaces/')) {
      throw new Error('Invalid Google Chat space name. Must start with "spaces/"');
    }

    const token = await this.getAccessToken();

    const body: Record<string, unknown> = { text };
    if (threadKey) {
      body.thread = { name: `${space}/threads/${threadKey}` };
    }

    const resp = await fetch(
      `https://chat.googleapis.com/v1/${space}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (!resp.ok) {
      const details = await resp.text();
      throw new Error(`Google Chat API send failed (${resp.status}): ${details}`);
    }
  }

  /**
   * Get a valid access token, refreshing if needed.
   *
   * Uses a simplified JWT-based OAuth2 flow for service accounts.
   *
   * @returns Valid access token string
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.serviceAccountKey) {
      throw new Error('Service account key not configured');
    }

    // For service account auth, we need to create a JWT and exchange it for an access token.
    // This is a simplified implementation — production use should use google-auth-library.
    const key = JSON.parse(this.serviceAccountKey);
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/chat.bot',
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
}

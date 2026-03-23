/**
 * WeChat iLink Bot Service
 *
 * Integrates with the Tencent iLink Bot API for WeChat messaging.
 * Supports QR code login, message polling, and sending replies.
 *
 * API Base: https://ilinkai.weixin.qq.com
 * Auth: Bearer token with AuthorizationType: ilink_bot_token header
 *
 * @module services/wechat/wechat.service
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ILINK_API_BASE = 'https://ilinkai.weixin.qq.com';

/** Endpoints for the iLink Bot API. */
const ENDPOINTS = {
  GET_QR_CODE: '/ilink/bot/get_bot_qrcode',
  QR_CODE_STATUS: '/ilink/bot/get_qrcode_status',
  GET_UPDATES: '/ilink/bot/getupdates',
  SEND_MESSAGE: '/ilink/bot/sendmessage',
} as const;

/** Default poll timeout for long-polling (seconds). */
const POLL_TIMEOUT_S = 35;

/** QR code status poll interval (milliseconds). */
const QR_STATUS_POLL_INTERVAL_MS = 5000;

/** Max time to wait for QR scan (milliseconds). */
const QR_SCAN_TIMEOUT_MS = 300_000;

/** Config storage path. */
const CONFIG_DIR = join(homedir(), '.crewly', 'wechat');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted WeChat config. */
export interface WeChatConfig {
  botToken: string;
  connectedAt: string;
  botName?: string;
}

/** QR code response from iLink API. */
export interface QRCodeResponse {
  qrcode_url: string;
  qrcode_ticket: string;
}

/** QR code status from iLink API. */
export interface QRCodeStatus {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  bot_token?: string;
  bot_name?: string;
}

/** Incoming WeChat message from getupdates. */
export interface WeChatMessage {
  msg_id: string;
  from_user: string;
  from_user_name: string;
  content: string;
  msg_type: string;
  context_token: string;
  timestamp: number;
}

/** Service connection state. */
export type WeChatConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * WeChat iLink Bot Service.
 *
 * Singleton service that manages the WeChat bot connection lifecycle:
 * - QR code generation for login
 * - Long-polling for incoming messages
 * - Sending replies
 * - Persisting credentials to disk
 *
 * Events:
 * - `message` — Fired for each incoming WeChat message
 * - `connected` — Fired when QR code scan is confirmed
 * - `disconnected` — Fired when service disconnects
 * - `error` — Fired on unrecoverable errors
 */
export class WeChatService extends EventEmitter {
  private static instance: WeChatService | null = null;
  private readonly logger: ComponentLogger;

  private state: WeChatConnectionState = 'disconnected';
  private botToken: string | null = null;
  private botName: string | null = null;
  private pollCursor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private isPolling = false;

  private constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('WeChatService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns WeChatService instance
   */
  static getInstance(): WeChatService {
    if (!WeChatService.instance) {
      WeChatService.instance = new WeChatService();
    }
    return WeChatService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    if (WeChatService.instance) {
      WeChatService.instance.disconnect();
    }
    WeChatService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get a QR code for WeChat login.
   *
   * Calls the iLink API to generate a QR code that the user scans
   * with their WeChat app to authorize the bot.
   *
   * @returns QR code URL and ticket for status polling
   * @throws Error if API call fails
   */
  async getQRCode(): Promise<QRCodeResponse> {
    this.state = 'connecting';
    this.logger.info('Requesting WeChat login QR code');

    const response = await fetch(`${ILINK_API_BASE}${ENDPOINTS.GET_QR_CODE}?bot_type=3`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      this.state = 'error';
      throw new Error(`Failed to get QR code: ${response.status}`);
    }

    const data = await response.json() as { errcode?: number; errmsg?: string; data?: QRCodeResponse };

    if (data.errcode && data.errcode !== 0) {
      this.state = 'error';
      throw new Error(`iLink API error: ${data.errmsg || data.errcode}`);
    }

    const qrData = data.data || data as unknown as QRCodeResponse;
    this.logger.info('QR code generated', { hasUrl: !!qrData.qrcode_url });
    return qrData;
  }

  /**
   * Poll the QR code status until the user scans and confirms.
   *
   * @param ticket - QR code ticket from getQRCode()
   * @returns Resolved when confirmed, rejected on timeout/error
   */
  async pollQRCodeStatus(ticket: string): Promise<{ botToken: string; botName?: string }> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkStatus = async () => {
        if (Date.now() - startTime > QR_SCAN_TIMEOUT_MS) {
          this.state = 'disconnected';
          reject(new Error('QR code scan timed out'));
          return;
        }

        try {
          const response = await fetch(`${ILINK_API_BASE}${ENDPOINTS.QR_CODE_STATUS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qrcode_ticket: ticket }),
          });

          if (!response.ok) {
            throw new Error(`Status check failed: ${response.status}`);
          }

          const data = await response.json() as { data?: QRCodeStatus };
          const status = data.data || data as unknown as QRCodeStatus;

          if (status.status === 'confirmed' && status.bot_token) {
            this.botToken = status.bot_token;
            this.botName = status.bot_name || null;
            this.state = 'connected';

            await this.persistConfig();
            this.startMessagePolling();
            this.emit('connected', { botName: this.botName });

            this.logger.info('WeChat connected', { botName: this.botName });
            resolve({ botToken: status.bot_token, botName: status.bot_name });
            return;
          }

          if (status.status === 'expired') {
            this.state = 'disconnected';
            reject(new Error('QR code expired'));
            return;
          }

          // Continue polling
          setTimeout(checkStatus, QR_STATUS_POLL_INTERVAL_MS);
        } catch (err) {
          this.logger.warn('QR status poll error', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Retry on transient errors
          setTimeout(checkStatus, QR_STATUS_POLL_INTERVAL_MS);
        }
      };

      checkStatus();
    });
  }

  /**
   * Send a message via WeChat.
   *
   * @param content - Message text
   * @param contextToken - Context token from the received message (maintains thread)
   * @throws Error if not connected or API call fails
   */
  async sendMessage(content: string, contextToken: string): Promise<void> {
    if (!this.botToken) {
      throw new Error('WeChat is not connected');
    }

    const response = await fetch(`${ILINK_API_BASE}${ENDPOINTS.SEND_MESSAGE}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: content },
        context_token: contextToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to send message: ${response.status} ${errorText}`);
    }

    this.logger.info('WeChat message sent', { contentLength: content.length });
  }

  /**
   * Get the current connection state.
   *
   * @returns Connection status object
   */
  getStatus(): { state: WeChatConnectionState; botName: string | null; connectedAt: string | null } {
    return {
      state: this.state,
      botName: this.botName,
      connectedAt: this.state === 'connected' ? new Date().toISOString() : null,
    };
  }

  /**
   * Check if the service is connected.
   *
   * @returns True if connected with a valid bot token
   */
  isConnected(): boolean {
    return this.state === 'connected' && !!this.botToken;
  }

  /**
   * Disconnect and stop message polling.
   */
  disconnect(): void {
    this.logger.info('Disconnecting WeChat');
    this.stopMessagePolling();
    this.botToken = null;
    this.botName = null;
    this.pollCursor = null;
    this.state = 'disconnected';
    this.emit('disconnected');
  }

  /**
   * Try to restore connection from persisted config.
   *
   * @returns True if config was loaded and connection restored
   */
  async tryRestore(): Promise<boolean> {
    try {
      const config = await this.loadConfig();
      if (config?.botToken) {
        this.botToken = config.botToken;
        this.botName = config.botName || null;
        this.state = 'connected';
        this.startMessagePolling();
        this.logger.info('WeChat connection restored from config', { botName: this.botName });
        return true;
      }
    } catch {
      // Config doesn't exist or is invalid
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Internal: Message Polling
  // -------------------------------------------------------------------------

  /**
   * Start long-polling for incoming messages.
   */
  private startMessagePolling(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollMessages();
  }

  /**
   * Stop message polling.
   */
  private stopMessagePolling(): void {
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Long-poll for new messages from the iLink API.
   * Automatically reschedules on completion or error.
   */
  private async pollMessages(): Promise<void> {
    if (!this.isPolling || !this.botToken) return;

    try {
      const body: Record<string, unknown> = { timeout: POLL_TIMEOUT_S };
      if (this.pollCursor) {
        body.cursor = this.pollCursor;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 10) * 1000);

      const response = await fetch(`${ILINK_API_BASE}${ENDPOINTS.GET_UPDATES}`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.logger.error('WeChat auth failed during polling — disconnecting');
          this.state = 'error';
          this.stopMessagePolling();
          this.emit('error', new Error('Authentication failed'));
          return;
        }
        throw new Error(`Poll failed: ${response.status}`);
      }

      const data = await response.json() as {
        data?: { messages?: WeChatMessage[]; cursor?: string };
      };

      if (data.data?.cursor) {
        this.pollCursor = data.data.cursor;
      }

      const messages = data.data?.messages || [];
      for (const msg of messages) {
        this.logger.info('WeChat message received', {
          from: msg.from_user_name,
          type: msg.msg_type,
          contentLength: msg.content.length,
        });
        this.emit('message', msg);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Timeout — normal for long-polling
      } else {
        this.logger.warn('WeChat poll error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Schedule next poll immediately (long-polling is self-regulating)
    if (this.isPolling) {
      this.pollTimer = setTimeout(() => this.pollMessages(), 1000);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Config Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist bot token to disk.
   */
  private async persistConfig(): Promise<void> {
    try {
      await mkdir(CONFIG_DIR, { recursive: true });
      const config: WeChatConfig = {
        botToken: this.botToken!,
        connectedAt: new Date().toISOString(),
        botName: this.botName || undefined,
      };
      await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
      this.logger.debug('WeChat config persisted');
    } catch (err) {
      this.logger.warn('Failed to persist WeChat config', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load persisted config from disk.
   *
   * @returns Config or null if not found
   */
  private async loadConfig(): Promise<WeChatConfig | null> {
    try {
      const data = await readFile(CONFIG_FILE, 'utf-8');
      return JSON.parse(data) as WeChatConfig;
    } catch {
      return null;
    }
  }

  /**
   * Remove persisted config from disk.
   */
  async removeConfig(): Promise<void> {
    try {
      const { unlink } = await import('fs/promises');
      await unlink(CONFIG_FILE);
    } catch {
      // File may not exist
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Helpers
  // -------------------------------------------------------------------------

  /**
   * Build authorization headers for iLink API.
   *
   * @returns Headers with Bearer token and AuthorizationType
   */
  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.botToken}`,
      AuthorizationType: 'ilink_bot_token',
    };
  }
}

/**
 * Get the WeChat service singleton.
 *
 * @returns WeChatService instance
 */
export function getWeChatService(): WeChatService {
  return WeChatService.getInstance();
}

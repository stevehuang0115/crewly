/**
 * Slack Service
 *
 * Manages Slack bot connection and messaging using Bolt SDK.
 * Enables bidirectional communication between Slack and Crewly.
 *
 * @module services/slack
 */

import { EventEmitter } from 'events';
import { createReadStream } from 'fs';
import { basename } from 'path';
import type {
  SlackConfig,
  SlackIncomingMessage,
  SlackOutgoingMessage,
  SlackServiceStatus,
  SlackConversationContext,
  SlackNotification,
  SlackBlock,
  SlackElement,
} from '../../types/slack.types.js';
import { isUserAllowed } from '../../types/slack.types.js';
import { CROSS_MACHINE_PREFIX } from '../../types/cross-machine.types.js';
import { SLACK_IMAGE_CONSTANTS, SLACK_FILE_UPLOAD_CONSTANTS, SLACK_DEDUP_CONSTANTS, SLACK_RECONNECT_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { ContentApprovalService } from '../onboarding/content-approval.service.js';
import { getAgentBehaviorLogService } from '../observability/agent-behavior-log.singleton.js';

/**
 * Events emitted by SlackService
 */
export interface SlackServiceEvents {
  message: (message: SlackIncomingMessage) => void;
  connected: () => void;
  disconnected: (error?: Error) => void;
  error: (error: Error) => void;
}

/**
 * Slack App interface (subset of Bolt App)
 */
interface SlackApp {
  client: SlackWebClient;
  message: (handler: (args: MessageEventArgs) => Promise<void>) => void;
  event: (
    eventType: string,
    handler: (args: AppMentionEventArgs) => Promise<void>
  ) => void;
  action: (
    actionIdOrPattern: string | RegExp,
    handler: (args: BlockActionEventArgs) => Promise<void>
  ) => void;
  error: (handler: (error: Error) => Promise<void>) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Slack Web Client interface
 */
interface SlackWebClient {
  auth: {
    test: () => Promise<{ ok?: boolean; team?: string; user?: string }>;
  };
  chat: {
    postMessage: (args: PostMessageArgs) => Promise<{ ts?: string }>;
    update: (args: UpdateMessageArgs) => Promise<void>;
  };
  reactions: {
    add: (args: AddReactionArgs) => Promise<void>;
  };
  users: {
    info: (args: { user: string }) => Promise<{
      user?: {
        name?: string;
        real_name?: string;
        profile?: { email?: string };
      };
    }>;
  };
  files: {
    uploadV2: (args: UploadFileArgs) => Promise<{ files?: Array<{ id: string }> }>;
    info: (args: { file: string }) => Promise<{
      file?: {
        url_private?: string;
        url_private_download?: string;
      };
    }>;
  };
}

/**
 * Arguments for files.uploadV2 API call
 */
interface UploadFileArgs {
  channel_id: string;
  file: Buffer | NodeJS.ReadableStream;
  filename: string;
  title?: string;
  initial_comment?: string;
  thread_ts?: string;
}

/**
 * Options for uploading a file to Slack.
 * Used by both uploadImage() and uploadFile().
 */
interface FileUploadOptions {
  channelId: string;
  filePath: string;
  filename?: string;
  title?: string;
  initialComment?: string;
  threadTs?: string;
}

interface PostMessageArgs {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

interface AddReactionArgs {
  channel: string;
  timestamp: string;
  name: string;
}

interface MessageEventArgs {
  message: {
    ts?: string;
    text?: string;
    user?: string;
    channel: string;
    thread_ts?: string;
    team?: string;
    files?: Array<{
      id: string;
      name: string;
      mimetype: string;
      filetype: string;
      size: number;
      url_private: string;
      url_private_download: string;
      thumb_360?: string;
      original_w?: number;
      original_h?: number;
      permalink: string;
    }>;
  };
  say: (text: string) => Promise<void>;
}

interface AppMentionEventArgs {
  event: {
    ts: string;
    text: string;
    user: string;
    channel: string;
    thread_ts?: string;
    team?: string;
    event_ts: string;
  };
}

/**
 * Arguments for Slack block_actions interactive event.
 * Received when a user clicks a button in a Block Kit message.
 */
interface BlockActionEventArgs {
  action: {
    action_id: string;
    value?: string;
    block_id?: string;
    type: string;
  };
  body: {
    user: { id: string; name?: string; username?: string };
    channel?: { id: string };
    message?: { ts: string };
    container?: { channel_id: string; message_ts: string };
  };
  ack: () => Promise<void>;
  respond: (msg: { text: string; replace_original?: boolean; response_type?: string }) => Promise<void>;
}

/**
 * Slack Service singleton instance
 */
let slackServiceInstance: SlackService | null = null;

/**
 * SlackService class for managing Slack bot operations
 */
export class SlackService extends EventEmitter {
  private logger = LoggerService.getInstance().createComponentLogger('SlackService');
  private app: SlackApp | null = null;
  private client: SlackWebClient | null = null;
  private config: SlackConfig | null = null;
  private status: SlackServiceStatus = {
    connected: false,
    socketMode: false,
    messagesSent: 0,
    messagesReceived: 0,
  };
  private conversationContexts: Map<string, SlackConversationContext> = new Map();

  /** Cached Bolt App constructor from the first successful dynamic import */
  private cachedAppConstructor: (new (opts: Record<string, unknown>) => unknown) | null = null;

  /** Cached Bolt LogLevel enum from the first successful dynamic import */
  private cachedLogLevelEnum: Record<string, unknown> | null = null;

  /**
   * Message deduplication tracker.
   * Maps a fingerprint (channelId:threadTs:textHash) to the timestamp it was sent.
   * Prevents identical messages from being sent to the same thread within a time window.
   */
  private recentMessageFingerprints: Map<string, number> = new Map();

  /** Whether a reconnection attempt is currently in progress */
  private reconnecting = false;
  /** Timer handle for the reconnection grace period */
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer handle for the periodic health check */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Current consecutive reconnection attempt count */
  private reconnectAttempts = 0;
  /** Whether the service has been intentionally shut down (skip auto-reconnect) */
  private intentionalDisconnect = false;
  /** Timestamp of the last successful Slack API ping */
  private lastPingAt = 0;
  /** Number of consecutive health-check ping failures */
  private consecutivePingFailures = 0;

  /**
   * Initialize the Slack service with configuration
   *
   * @param config - Slack bot configuration
   * @returns Promise that resolves when connected
   */
  async initialize(config: SlackConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    try {
      // Dynamic import of @slack/bolt (CJS module requires default import handling).
      // Cache the constructor and LogLevel on first import for reuse in reconnect.
      const boltModule = await import('@slack/bolt') as Record<string, unknown>;
      const defaultExport = boltModule.default as Record<string, unknown> | undefined;
      const App = (boltModule.App ?? defaultExport?.App) as new (opts: Record<string, unknown>) => unknown;
      const LogLevel = (boltModule.LogLevel ?? defaultExport?.LogLevel) as Record<string, unknown> | undefined;
      this.cachedAppConstructor = App;
      this.cachedLogLevelEnum = LogLevel ?? null;

      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        signingSecret: config.signingSecret,
        socketMode: config.socketMode,
        logLevel: (LogLevel as Record<string, unknown>)?.INFO ?? 'info',
      }) as unknown as SlackApp;

      this.client = this.app.client;

      // Set up event handlers
      this.setupEventHandlers();

      // Start the app
      if (config.socketMode) {
        await this.app.start();
        this.status.connected = true;
        this.status.socketMode = true;

        // Monitor SocketModeClient connection state for logging and status tracking
        this.setupConnectionMonitoring();

        this.emit('connected');
        this.logger.info('Connected in Socket Mode');
      }
    } catch (error) {
      // Ensure partially initialized Bolt app is torn down to avoid
      // lingering socket retries/background tasks after failed startup.
      if (this.app) {
        try {
          await this.app.stop();
        } catch {
          // Ignore shutdown errors during failed initialization
        }
      }
      this.app = null;
      this.client = null;
      this.status.connected = false;
      this.status.socketMode = false;
      this.status.lastError = (error as Error).message;
      this.status.lastErrorAt = new Date().toISOString();
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Set up Slack event handlers
   */
  private setupEventHandlers(): void {
    if (!this.app || !this.config) return;

    const config = this.config;

    // Handle direct messages
    this.app.message(async ({ message }) => {
      // Allow messages with text or files (or both)
      if (!message.text && (!message.files || message.files.length === 0)) return;
      if (!message.user) return;

      // Bypass user permission check for cross-machine messages —
      // these come from other bots and are authenticated by device ID,
      // not Slack user ID. The CrossMachineMessageService handles its
      // own security (device identity, target filtering, deduplication).
      const isCrossMachine = message.text && message.text.startsWith(CROSS_MACHINE_PREFIX);

      // Check user permissions (skip for cross-machine messages)
      if (!isCrossMachine && !isUserAllowed(message.user, config)) {
        this.logger.info('Unauthorized user', { userId: message.user });
        return;
      }

      // Pass ALL files through; downstream services handle image vs non-image distinction
      const allFiles = (message.files || []) as import('../../types/slack.types.js').SlackFile[];
      const imageFiles = allFiles.filter(f => f.mimetype?.startsWith('image/'));

      const incomingMessage: SlackIncomingMessage = {
        id: message.ts || '',
        type: 'message',
        text: message.text || '',
        userId: message.user,
        channelId: message.channel,
        threadTs: message.thread_ts,
        ts: message.ts || '',
        teamId: message.team || '',
        eventTs: message.ts || '',
        files: allFiles.length > 0 ? allFiles : undefined,
        hasImages: imageFiles.length > 0,
        hasFiles: allFiles.length > 0,
      };

      this.status.messagesReceived++;
      this.status.lastEventAt = new Date().toISOString();
      this.emit('message', incomingMessage);
    });

    // Handle @mentions
    this.app.event('app_mention', async ({ event }) => {
      if (!isUserAllowed(event.user, config)) {
        this.logger.info('Unauthorized user mention', { userId: event.user });
        return;
      }

      const incomingMessage: SlackIncomingMessage = {
        id: event.ts,
        type: 'app_mention',
        text: event.text,
        userId: event.user,
        channelId: event.channel,
        threadTs: event.thread_ts,
        ts: event.ts,
        teamId: event.team || '',
        eventTs: event.event_ts,
      };

      this.status.messagesReceived++;
      this.status.lastEventAt = new Date().toISOString();
      this.emit('message', incomingMessage);
    });

    // Handle content approval button clicks (Block Kit interactive actions)
    this.app.action(/content_approval_(approve|reject)/, async ({ action, body, ack, respond }) => {
      await ack();

      const approvalId = action.value;
      const actionType = action.action_id;
      const slackUserName = body.user.name || body.user.username || body.user.id;
      const channelId = body.channel?.id || body.container?.channel_id;
      const messageTs = body.message?.ts || body.container?.message_ts;

      if (!approvalId) {
        await respond({ text: 'Error: Missing approval ID.', replace_original: false, response_type: 'ephemeral' });
        return;
      }

      try {
        const service = ContentApprovalService.getInstance();
        const existing = service.get(approvalId);

        if (!existing) {
          await respond({ text: `Approval \`${approvalId.slice(0, 8)}\` not found.`, replace_original: false, response_type: 'ephemeral' });
          return;
        }

        if (existing.status !== 'pending') {
          await respond({
            text: `This approval has already been ${existing.status} by ${existing.resolvedBy ?? 'someone'}.`,
            replace_original: false,
            response_type: 'ephemeral',
          });
          return;
        }

        const isApprove = actionType === 'content_approval_approve';
        const result = isApprove
          ? service.approve(approvalId, slackUserName)
          : service.reject(approvalId, slackUserName);

        if (!result) {
          await respond({ text: 'Failed to resolve approval.', replace_original: false, response_type: 'ephemeral' });
          return;
        }

        // Update the original message to replace buttons with status
        const statusEmoji = isApprove ? '\u2705' : '\u274c';
        const statusText = isApprove ? 'Approved' : 'Rejected';
        const updatedText = `${statusEmoji} ${statusText} by @${slackUserName}`;

        if (channelId && messageTs) {
          const updatedBlocks: SlackBlock[] = [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `~${existing.content.slice(0, 200)}~` },
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `${updatedText} \u2022 ${new Date().toLocaleString()}` } as unknown as SlackElement,
              ],
            },
          ];

          await this.updateMessage(channelId, messageTs, updatedText, updatedBlocks);
        }

        this.emit('content_approval_resolved', {
          approvalId,
          action: isApprove ? 'approved' : 'rejected',
          resolvedBy: slackUserName,
        });

        this.logger.info('Content approval resolved via Slack button', {
          approvalId: approvalId.slice(0, 8),
          action: statusText.toLowerCase(),
          resolvedBy: slackUserName,
        });
      } catch (err) {
        this.logger.error('Content approval action handler error', {
          approvalId: approvalId?.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
        await respond({
          text: `Error processing approval: ${err instanceof Error ? err.message : 'Unknown error'}`,
          replace_original: false,
          response_type: 'ephemeral',
        });
      }
    });

    // Handle errors
    this.app.error(async (error) => {
      this.logger.error('Error', { error: error.message });
      this.status.lastError = error.message;
      this.status.lastErrorAt = new Date().toISOString();
      this.emit('error', error);
    });
  }

  /**
   * Attach listeners to the underlying SocketModeClient to track
   * connection lifecycle (disconnected, reconnecting, connected).
   * Updates `status.connected` so health checks reflect actual state.
   *
   * The Bolt App stores the receiver at `app.receiver`, and the
   * SocketModeReceiver exposes `client` (SocketModeClient), which
   * is an EventEmitter emitting: connected, reconnecting, disconnected, close.
   */
  private setupConnectionMonitoring(): void {
    // Access the SocketModeClient from Bolt's internal receiver.
    // This relies on Bolt's internal structure, so we guard with try/catch.
    try {
      const receiver = (this.app as unknown as { receiver?: { client?: EventEmitter } })?.receiver;
      const socketClient = receiver?.client;
      if (!socketClient) {
        this.logger.warn('Could not access SocketModeClient for connection monitoring');
        return;
      }

      // Issue #548 — `@slack/socket-mode`'s finity state machine throws
      // `Unhandled event 'server explicit disconnect' in state 'connecting'`
      // when Slack sends a disconnect signal during the reconnect
      // handshake window. The throw is SYNCHRONOUS inside the WebSocket
      // message callback (WebSocket.onMessage → SocketModeClient.
      // onWebSocketMessage → finity.handle → throw) so it surfaces as
      // an uncaughtException that takes the process down on v1 hosts
      // (no pm2/systemd to restart). CrewlyNode1 went dark for ~21
      // hours on 2026-05-14 from exactly this.
      //
      // Wrap `onWebSocketMessage` with a synchronous try/catch that
      // swallows the unhandled-event throw, logs it as a recoverable
      // event, and triggers the reconnect path. Other throws still
      // surface normally — we only suppress the specific finity
      // "Unhandled event" signature.
      const wrappedClient = socketClient as unknown as {
        onWebSocketMessage?: (...args: unknown[]) => unknown;
      };
      const originalOnMessage = wrappedClient.onWebSocketMessage;
      if (typeof originalOnMessage === 'function') {
        wrappedClient.onWebSocketMessage = (...args: unknown[]) => {
          try {
            return originalOnMessage.apply(socketClient, args);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Unhandled event/.test(msg)) {
              this.logger.warn(
                'Suppressed finity unhandled-event from SocketModeClient (issue #548) — triggering reconnect',
                {
                  error: msg,
                },
              );
              this.status.connected = false;
              this.status.lastError = `SocketMode finity throw: ${msg}`;
              this.status.lastErrorAt = new Date().toISOString();
              this.scheduleReconnect();
              return undefined;
            }
            throw err;
          }
        };
        this.logger.info('SocketModeClient.onWebSocketMessage wrapped for #548 finity-throw recovery');
      } else {
        this.logger.warn(
          'SocketModeClient.onWebSocketMessage not found — #548 finity-throw guard NOT installed',
        );
      }

      socketClient.on('disconnected', () => {
        this.status.connected = false;
        this.status.lastError = 'Socket Mode connection lost';
        this.status.lastErrorAt = new Date().toISOString();
        this.logger.warn('Socket Mode disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      socketClient.on('reconnecting', () => {
        this.status.connected = false;
        this.logger.info('Socket Mode reconnecting (Bolt built-in)...');
      });

      socketClient.on('connected', () => {
        this.status.connected = true;
        this.reconnectAttempts = 0;
        this.consecutivePingFailures = 0;
        this.lastPingAt = Date.now();
        this.cancelReconnectGrace();
        this.logger.info('Socket Mode reconnected');
        this.emit('connected');
      });

      socketClient.on('close', () => {
        // 'close' fires on WebSocket close before reconnection kicks in
        if (this.status.connected) {
          this.status.connected = false;
          this.logger.warn('Socket Mode WebSocket closed, awaiting reconnect...');
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      this.logger.warn('Failed to set up connection monitoring', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start periodic health check
    this.startHealthCheck();
  }

  /**
   * Start a periodic health check that verifies the Socket Mode connection
   * is alive and triggers reconnection if it has silently died.
   *
   * Uses an active Slack API ping (auth.test) to detect half-open sockets
   * that appear connected but are actually dead after WiFi/network drops.
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.lastPingAt = Date.now();
    this.consecutivePingFailures = 0;

    this.healthCheckTimer = setInterval(async () => {
      if (this.intentionalDisconnect) return;

      // Case 1: Already known to be disconnected — trigger reconnect
      if (!this.status.connected && !this.reconnecting) {
        this.logger.warn('Health check: Socket Mode not connected and no reconnect in progress — triggering reconnect');
        this.attemptReconnect();
        return;
      }

      // Case 2: Status says connected — verify with an active API ping
      if (this.status.connected && this.client && !this.reconnecting) {
        try {
          const pingPromise = this.client.auth.test();
          const timeoutMs = SLACK_RECONNECT_CONSTANTS.PING_TIMEOUT_MS;
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('Ping timeout')), timeoutMs);
            // Clear timer if ping resolves first to prevent leak
            pingPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
          });
          await Promise.race([pingPromise, timeoutPromise]);

          // Ping succeeded — connection is truly alive
          this.lastPingAt = Date.now();
          this.consecutivePingFailures = 0;
        } catch (err) {
          this.consecutivePingFailures++;
          this.logger.warn('Health check ping failed', {
            consecutiveFailures: this.consecutivePingFailures,
            error: err instanceof Error ? err.message : String(err),
          });

          // After consecutive failures, declare connection dead and reconnect
          if (this.consecutivePingFailures >= SLACK_RECONNECT_CONSTANTS.PING_FAILURES_BEFORE_RECONNECT) {
            this.logger.warn('Health check: connection appears dead after consecutive ping failures — forcing reconnect', {
              consecutiveFailures: this.consecutivePingFailures,
              lastPingAt: new Date(this.lastPingAt).toISOString(),
            });
            this.status.connected = false;
            this.consecutivePingFailures = 0;
            this.attemptReconnect();
          }
        }
      }
    }, SLACK_RECONNECT_CONSTANTS.HEALTH_CHECK_INTERVAL_MS);
    // Allow Node to exit even if health check timer is still active
    if (this.healthCheckTimer && typeof this.healthCheckTimer === 'object' && 'unref' in this.healthCheckTimer) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Stop the periodic health check timer.
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Schedule a reconnection attempt after a grace period.
   * The grace period gives Bolt's built-in reconnect a chance to recover first.
   * If the connection comes back within the grace period, the reconnect is cancelled.
   */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnecting || this.reconnectGraceTimer) return;

    this.logger.info('Scheduling reconnect after grace period', {
      gracePeriodMs: SLACK_RECONNECT_CONSTANTS.GRACE_PERIOD_MS,
    });

    this.reconnectGraceTimer = setTimeout(() => {
      this.reconnectGraceTimer = null;
      if (!this.status.connected && !this.intentionalDisconnect) {
        this.logger.warn('Grace period expired, Bolt reconnect did not recover — starting manual reconnect');
        this.attemptReconnect();
      }
    }, SLACK_RECONNECT_CONSTANTS.GRACE_PERIOD_MS);
  }

  /**
   * Cancel the reconnection grace period timer.
   */
  private cancelReconnectGrace(): void {
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
    }
  }

  /**
   * Attempt to reconnect by tearing down the current Bolt app and
   * re-initializing from scratch with the saved config.
   * Uses exponential backoff between attempts.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || this.intentionalDisconnect || !this.config) return;

    const maxAttempts = SLACK_RECONNECT_CONSTANTS.MAX_ATTEMPTS;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.logger.error('Max reconnection attempts reached, giving up', {
        attempts: this.reconnectAttempts,
        maxAttempts,
      });
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(
      SLACK_RECONNECT_CONSTANTS.INITIAL_DELAY_MS * Math.pow(SLACK_RECONNECT_CONSTANTS.BACKOFF_MULTIPLIER, this.reconnectAttempts - 1),
      SLACK_RECONNECT_CONSTANTS.MAX_DELAY_MS,
    );

    this.logger.info('Reconnecting to Slack Socket Mode', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    await new Promise(resolve => setTimeout(resolve, delay));

    // Bail out if we reconnected or intentionally disconnected while waiting
    if (this.status.connected || this.intentionalDisconnect) {
      this.reconnecting = false;
      return;
    }

    try {
      // Guard: cached App constructor must be available from initialize()
      if (!this.cachedAppConstructor) {
        throw new Error('App constructor not cached — initialize() must be called before reconnect');
      }

      // Tear down existing app
      if (this.app) {
        try {
          await this.app.stop();
        } catch {
          // Ignore teardown errors
        }
        this.app = null;
        this.client = null;
      }

      // Re-initialize using cached constructor (avoids stale dynamic import issues)
      const App = this.cachedAppConstructor;
      const LogLevel = this.cachedLogLevelEnum;

      this.app = new App({
        token: this.config.botToken,
        appToken: this.config.appToken,
        signingSecret: this.config.signingSecret,
        socketMode: this.config.socketMode,
        logLevel: (LogLevel as Record<string, unknown>)?.INFO ?? 'info',
      }) as unknown as SlackApp;

      this.client = this.app.client;
      this.setupEventHandlers();

      await this.app.start();
      this.status.connected = true;
      this.status.socketMode = true;
      this.reconnectAttempts = 0;
      this.reconnecting = false;
      this.consecutivePingFailures = 0;
      this.lastPingAt = Date.now();

      this.setupConnectionMonitoring();
      this.emit('connected');
      this.logger.info('Successfully reconnected to Slack Socket Mode');
    } catch (error) {
      this.reconnecting = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.status.lastError = `Reconnect failed: ${errorMessage}`;
      this.status.lastErrorAt = new Date().toISOString();

      // Classify error: fatal errors stop the loop, transient errors retry
      if (this.isFatalReconnectError(error)) {
        this.logger.error('Fatal reconnection error — stopping retry loop', {
          attempt: this.reconnectAttempts,
          error: errorMessage,
        });
        this.emit('error', error instanceof Error ? error : new Error(errorMessage));
        return;
      }

      this.logger.error('Transient reconnection error — will retry', {
        attempt: this.reconnectAttempts,
        error: errorMessage,
      });
      // Schedule next attempt — the health check will also retry if this doesn't fire
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Classify whether a reconnection error is fatal (non-recoverable)
   * or transient (may succeed on retry).
   *
   * Fatal errors: missing constructor, invalid config, auth errors.
   * Transient errors: network timeouts, temporary server errors.
   *
   * @param error - The error caught during reconnection
   * @returns True if the error is fatal and retrying would be futile
   */
  private isFatalReconnectError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    /** Patterns that indicate a non-recoverable configuration or code error */
    const fatalPatterns = [
      'not a constructor',
      'is not a function',
      'constructor not cached',
      'invalid_auth',
      'token_revoked',
      'account_inactive',
      'missing required',
      'config',
    ];

    return fatalPatterns.some(pattern => lowerMessage.includes(pattern));
  }

  /**
   * Send a message to Slack with content-based deduplication.
   *
   * Generates a fingerprint from (channelId, threadTs, text) and suppresses
   * duplicate sends within a configurable time window (default 30s).
   * This is the single chokepoint for all Slack message sends — skill delivery,
   * bridge fallback, and direct API calls all converge here.
   *
   * @param message - Message to send
   * @returns Promise with message timestamp (empty string if deduplicated)
   */
  async sendMessage(message: SlackOutgoingMessage): Promise<string> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    // Content-based deduplication: suppress identical messages within time window
    const fingerprint = this.buildMessageFingerprint(message);
    const now = Date.now();
    const lastSentAt = this.recentMessageFingerprints.get(fingerprint);
    if (lastSentAt !== undefined && (now - lastSentAt) < SLACK_DEDUP_CONSTANTS.DEDUP_WINDOW_MS) {
      this.logger.info('Slack message deduplicated — identical message sent recently', {
        channelId: message.channelId,
        threadTs: message.threadTs,
        ageMs: now - lastSentAt,
      });
      return '';
    }

    try {
      const result = await this.client.chat.postMessage({
        channel: message.channelId,
        text: message.text,
        thread_ts: message.threadTs,
        blocks: message.blocks,
        attachments: message.attachments,
        unfurl_links: message.unfurlLinks,
        unfurl_media: message.unfurlMedia,
      });

      this.status.messagesSent++;

      // Track this fingerprint for future dedup
      this.trackMessageFingerprint(fingerprint, now);

      return result.ts || '';
    } catch (error) {
      this.logger.error('Send message error', { error: error instanceof Error ? (error as Error).message : String(error) });

      // F14: record slack.delivery.failed event (best-effort — never
      // changes retry semantics or throws). The wrapper swallows
      // construction errors and `record()` itself swallows DB errors.
      try {
        const errMessage =
          error instanceof Error ? error.message : String(error);
        getAgentBehaviorLogService()?.record({
          type: 'slack.delivery.failed',
          agent: '',
          thread: `${message.channelId}:${message.threadTs ?? ''}`,
          reason: 'api_error',
          details: {
            errorMessage: errMessage,
            textLength: (message.text ?? '').length,
            hasBlocks: Array.isArray(message.blocks) && message.blocks.length > 0,
          },
        });
      } catch {
        /* observability is best-effort — never block the original throw */
      }

      throw error;
    }
  }

  /**
   * Build a deduplication fingerprint for a Slack message.
   * Combines channelId, threadTs, and a simple hash of the message text.
   *
   * @param message - Outgoing Slack message
   * @returns Fingerprint string
   */
  private buildMessageFingerprint(message: SlackOutgoingMessage): string {
    // Simple string hash (djb2) — fast and sufficient for dedup
    let hash = 5381;
    const text = message.text || '';
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return `${message.channelId}:${message.threadTs || ''}:${hash}`;
  }

  /**
   * Track a message fingerprint and evict stale entries.
   *
   * @param fingerprint - Message fingerprint to track
   * @param timestamp - Current timestamp in ms
   */
  private trackMessageFingerprint(fingerprint: string, timestamp: number): void {
    this.recentMessageFingerprints.set(fingerprint, timestamp);

    // Evict expired entries and enforce size limit
    if (this.recentMessageFingerprints.size > SLACK_DEDUP_CONSTANTS.MAX_TRACKED_MESSAGES) {
      const windowMs = SLACK_DEDUP_CONSTANTS.DEDUP_WINDOW_MS;
      for (const [key, ts] of this.recentMessageFingerprints) {
        if (timestamp - ts > windowMs) {
          this.recentMessageFingerprints.delete(key);
        }
      }
      // If still over limit after expiry cleanup, drop oldest
      if (this.recentMessageFingerprints.size > SLACK_DEDUP_CONSTANTS.MAX_TRACKED_MESSAGES) {
        const firstKey = this.recentMessageFingerprints.keys().next().value;
        if (firstKey !== undefined) {
          this.recentMessageFingerprints.delete(firstKey);
        }
      }
    }
  }

  /**
   * Send a notification to the default channel
   *
   * @param notification - Notification to send
   */
  async sendNotification(notification: SlackNotification): Promise<void> {
    const targetChannelId = notification.channelId || this.config?.defaultChannelId;
    if (!targetChannelId) {
      this.logger.warn('No channel configured for notification');
      return;
    }

    const blocks = this.formatNotificationBlocks(notification);

    await this.sendMessage({
      channelId: targetChannelId,
      text: `${notification.title}: ${notification.message}`,
      blocks,
      threadTs: notification.threadTs,
    });
  }

  /**
   * Format notification as Slack blocks
   *
   * @param notification - Notification to format
   * @returns Slack blocks for the notification
   */
  private formatNotificationBlocks(notification: SlackNotification): SlackBlock[] {
    const urgencyEmoji: Record<string, string> = {
      low: ':white_circle:',
      normal: ':large_blue_circle:',
      high: ':large_orange_circle:',
      critical: ':red_circle:',
    };

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${urgencyEmoji[notification.urgency]} ${notification.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: notification.message,
        },
      },
    ];

    // Context block elements are text objects where `text` is a plain string.
    // Using type assertion because SlackElement.text is typed as SlackTextObject
    // but Slack API context elements use text objects directly as elements.
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Sent at ${new Date(notification.timestamp).toLocaleString()}`,
        } as unknown as import('../../types/slack.types.js').SlackElement,
      ],
    });

    return blocks;
  }

  /**
   * Update a message
   *
   * @param channelId - Channel ID
   * @param messageTs - Message timestamp
   * @param text - New text
   * @param blocks - Optional new blocks
   */
  async updateMessage(
    channelId: string,
    messageTs: string,
    text: string,
    blocks?: SlackBlock[]
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    await this.client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks,
    });
  }

  /**
   * Add a reaction to a message
   *
   * @param channelId - Channel ID
   * @param messageTs - Message timestamp
   * @param emoji - Emoji name (without colons)
   */
  async addReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    await this.client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: emoji,
    });
  }

  /**
   * Get or create conversation context for a thread
   *
   * @param threadTs - Thread timestamp
   * @param channelId - Channel ID
   * @param userId - User ID
   * @returns Conversation context
   */
  getConversationContext(
    threadTs: string,
    channelId: string,
    userId: string
  ): SlackConversationContext {
    const key = `${channelId}:${threadTs}`;
    // NOTE: This is intentionally NOT `synthesizeSlackConversationId`
    // (chat-v2/legacy-dto.utils.ts). That helper produces the chat-v2
    // channel id by replacing the single dot in the Slack ts. The id
    // built here is for an in-memory `SlackConversationContext` map keyed
    // by a broader sanitized form (any non-alphanumeric → `-`) and may
    // diverge from the chat-v2 channel id by design. Do not "unify" —
    // see the 2026-05-15 review of PR #547 for the discussion.
    const conversationId = `slack-${channelId}-${threadTs}`.replace(/[^A-Za-z0-9_-]/g, '-');
    let context = this.conversationContexts.get(key);

    if (!context) {
      context = {
        threadTs,
        channelId,
        userId,
        conversationId,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        messageCount: 0,
      };
      this.conversationContexts.set(key, context);
    } else if (context.conversationId !== conversationId) {
      context.conversationId = conversationId;
    }

    context.lastActivityAt = new Date().toISOString();
    context.messageCount++;
    return context;
  }

  /**
   * Get service status
   *
   * @returns Current service status
   */
  getStatus(): SlackServiceStatus {
    return { ...this.status };
  }

  /**
   * Check if service is connected
   *
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Get the bot token used to initialize the Slack client.
   * Required for downloading private files from Slack.
   *
   * @returns The bot token string, or null if not initialized
   */
  getBotToken(): string | null {
    return this.config?.botToken || null;
  }

  /**
   * Upload an image file to a Slack channel.
   *
   * Delegates to the shared upload-with-retry logic.
   * Kept as a separate public method for backward compatibility
   * with callers that use the image-specific endpoint.
   *
   * @param options - Upload configuration
   * @returns Object with the uploaded file ID
   * @throws Error if the client is not initialized or upload fails
   */
  async uploadImage(options: FileUploadOptions): Promise<{ fileId?: string }> {
    return this.uploadWithRetry(options, SLACK_IMAGE_CONSTANTS);
  }

  /**
   * Upload any supported file to a Slack channel.
   *
   * Delegates to the shared upload-with-retry logic.
   * Works for PDFs, images, documents, and other file types supported by Slack.
   *
   * @param options - Upload configuration
   * @returns Object with the uploaded file ID
   * @throws Error if the client is not initialized or upload fails
   */
  async uploadFile(options: FileUploadOptions): Promise<{ fileId?: string }> {
    return this.uploadWithRetry(options, SLACK_FILE_UPLOAD_CONSTANTS);
  }

  /**
   * Shared upload logic with retry/backoff for Slack rate limits.
   *
   * Reads the file from disk and uploads via files.uploadV2.
   * Retries on 429 responses with exponential backoff capped at 60s.
   *
   * @param options - Upload configuration (channel, path, filename, etc.)
   * @param constants - Constants object providing UPLOAD_MAX_RETRIES and UPLOAD_DEFAULT_BACKOFF_MS
   * @returns Object with the uploaded file ID
   * @throws Error if the client is not initialized, retries exhausted, or a non-rate-limit error occurs
   */
  private async uploadWithRetry(
    options: FileUploadOptions,
    constants: { UPLOAD_MAX_RETRIES: number; UPLOAD_DEFAULT_BACKOFF_MS: number },
  ): Promise<{ fileId?: string }> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    const filename = options.filename || basename(options.filePath);
    const maxRetries = constants.UPLOAD_MAX_RETRIES;
    const MAX_BACKOFF_MS = 60_000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const fileStream = createReadStream(options.filePath);

      try {
        const result = await this.client.files.uploadV2({
          channel_id: options.channelId,
          file: fileStream,
          filename,
          title: options.title,
          initial_comment: options.initialComment,
          thread_ts: options.threadTs,
        });

        this.status.messagesSent++;
        return { fileId: result.files?.[0]?.id };
      } catch (error: unknown) {
        fileStream.destroy();

        const isRateLimit = this.isRateLimitError(error);
        if (isRateLimit && attempt < maxRetries) {
          const rawMs = this.extractRetryAfterMs(error) || constants.UPLOAD_DEFAULT_BACKOFF_MS;
          const retryAfterMs = Math.min(rawMs, MAX_BACKOFF_MS);
          this.logger.warn('Upload rate-limited (429), retrying', { retryAfterMs, attempt: attempt + 1, maxRetries });
          await new Promise(resolve => setTimeout(resolve, retryAfterMs));
          continue;
        }

        this.logger.error('Upload error', { error: error instanceof Error ? (error as Error).message : String(error) });
        throw error;
      }
    }

    throw new Error('Upload failed after maximum retries');
  }

  /**
   * Check if an error is a Slack 429 rate limit error.
   *
   * @param error - The caught error
   * @returns True if the error represents a 429 rate limit response
   */
  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      // @slack/web-api throws errors with code 'slack_webapi_rate_limited_error'
      if (err.code === 'slack_webapi_rate_limited_error') return true;
      // Also check for status 429 in case of raw HTTP errors
      if (err.statusCode === 429 || err.status === 429) return true;
    }
    return false;
  }

  /**
   * Extract the retry-after delay from a Slack rate limit error.
   *
   * @param error - The caught error
   * @returns Retry delay in milliseconds, or null if not found
   */
  private extractRetryAfterMs(error: unknown): number | null {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      // @slack/web-api attaches retryAfter (seconds) to the error
      if (typeof err.retryAfter === 'number') {
        return err.retryAfter * 1000;
      }
      // Check headers in case of raw response
      const headers = err.headers as Record<string, string> | undefined;
      if (headers?.['retry-after']) {
        const seconds = parseInt(headers['retry-after'], 10);
        if (!isNaN(seconds)) return seconds * 1000;
      }
    }
    return null;
  }

  /**
   * Disconnect from Slack
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.cancelReconnectGrace();
    this.stopHealthCheck();
    if (this.app) {
      await this.app.stop();
      this.status.connected = false;
      this.emit('disconnected');
      this.logger.info('Disconnected');
    }
  }

  /**
   * Get file info from Slack via the files.info API.
   * Requires the bot token to have `files:read` scope.
   *
   * @param fileId - Slack file ID (e.g., F0123ABC456)
   * @returns Object with private download URLs
   * @throws Error if the client is not initialized or API call fails
   */
  async getFileInfo(fileId: string): Promise<{ url_private: string; url_private_download: string }> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    const result = await this.client.files.info({ file: fileId });
    return {
      url_private: result.file?.url_private || '',
      url_private_download: result.file?.url_private_download || '',
    };
  }

  /**
   * Get user info from Slack
   *
   * @param userId - Slack user ID
   * @returns User info object
   */
  async getUserInfo(
    userId: string
  ): Promise<{ name: string; realName: string; email?: string }> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    const result = await this.client.users.info({ user: userId });
    return {
      name: result.user?.name || userId,
      realName: result.user?.real_name || userId,
      email: result.user?.profile?.email,
    };
  }
}

/**
 * Get the SlackService singleton instance
 *
 * @returns SlackService instance
 */
export function getSlackService(): SlackService {
  if (!slackServiceInstance) {
    slackServiceInstance = new SlackService();
  }
  return slackServiceInstance;
}

/**
 * Reset the SlackService instance (for testing)
 */
export function resetSlackService(): void {
  if (slackServiceInstance) {
    slackServiceInstance.disconnect().catch(() => {});
    slackServiceInstance = null;
  }
}

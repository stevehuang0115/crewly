/**
 * Slack Service
 *
 * Manages Slack bot connection and messaging using Bolt SDK.
 * Enables bidirectional communication between Slack and Crewly.
 *
 * @module services/slack
 */

import { EventEmitter } from 'events';
import { localAgentSession } from './slack-team-channel.service.js';
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
  SlackChannelInfo,
  SlackTransport,
  SlackRawInboundEvent,
  SlackInboundMeta,
  SlackCloudEventEnvelope,
} from '../../types/slack.types.js';
import { isUserAllowed } from '../../types/slack.types.js';
import { CROSS_MACHINE_PREFIX } from '../../types/cross-machine.types.js';
import { SLACK_IMAGE_CONSTANTS, SLACK_FILE_UPLOAD_CONSTANTS, SLACK_DEDUP_CONSTANTS, SLACK_RECONNECT_CONSTANTS, SLACK_TEAM_CHANNEL_CONSTANTS, SLACK_CLOUD_CONSTANTS, ORCHESTRATOR_SESSION_NAME,
  SLACK_NOTIFICATION_FALLBACK_MAX_CANDIDATES,
} from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { resolveFallbackNotificationChannels } from './slack-notification-fallback.js';
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
    test: () => Promise<{ ok?: boolean; team?: string; user?: string; user_id?: string; bot_id?: string }>;
  };
  chat: {
    postMessage: (args: PostMessageArgs) => Promise<{ ts?: string }>;
    update: (args: UpdateMessageArgs) => Promise<void>;
  };
  /**
   * Conversations API subset used by Slack team channels. Optional on the
   * interface so older test doubles that only stub `chat` keep compiling.
   */
  conversations?: {
    create: (args: { name: string; is_private?: boolean }) => Promise<{ channel?: RawSlackChannel }>;
    list: (args: { types?: string; limit?: number; cursor?: string; exclude_archived?: boolean }) => Promise<{
      channels?: RawSlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>;
    info: (args: { channel: string }) => Promise<{ channel?: RawSlackChannel }>;
    join: (args: { channel: string }) => Promise<{ channel?: RawSlackChannel }>;
    invite: (args: { channel: string; users: string }) => Promise<unknown>;
    archive: (args: { channel: string }) => Promise<unknown>;
    setPurpose: (args: { channel: string; purpose: string }) => Promise<unknown>;
    /** Rename a channel. Optional so older test doubles keep compiling. */
    rename?: (args: { channel: string; name: string }) => Promise<{ channel?: RawSlackChannel }>;
    /** Open (or reuse) a DM channel. `token` posts as another bot user. */
    open: (args: { users: string; token?: string }) => Promise<{ channel?: { id?: string } }>;
    /** Member ids of a channel (paginated). Optional so older test doubles compile. */
    members?: (args: { channel: string; limit?: number; cursor?: string }) => Promise<{
      members?: string[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
  reactions: {
    add: (args: AddReactionArgs) => Promise<void>;
  };
  users: {
    info: (args: { user: string }) => Promise<{
      user?: {
        id?: string;
        name?: string;
        real_name?: string;
        is_bot?: boolean;
        profile?: { email?: string; display_name?: string };
      };
    }>;
    /**
     * Directory listing, used to turn an `@handle` into a user id. Optional
     * on the interface so older test doubles that only stub `info` compile.
     */
    list?: (args: { limit?: number; cursor?: string }) => Promise<{
      members?: RawSlackMember[];
      response_metadata?: { next_cursor?: string };
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
  /** Per-message identity (`chat:write.customize`) — see SlackOutgoingMessage. */
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  /** Per-call token override (post as another bot user). */
  token?: string;
}

/**
 * Raw member object as returned by `users.list`.
 */
interface RawSlackMember {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

/**
 * Raw channel object as returned by the Slack conversations API.
 */
interface RawSlackChannel {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_private?: boolean;
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
 * The slice of CloudSyncService the cloud transport listens on: relay
 * messages of type `slack_event` carry a {@link SlackCloudEventEnvelope}.
 */
export interface SlackCloudEventSource {
  on(event: 'message', handler: (msg: SlackCloudRelayMessage) => void): unknown;
  off(event: 'message', handler: (msg: SlackCloudRelayMessage) => void): unknown;
}

/** Minimal relay message shape (see `cloud-sync.types.ts` IncomingMessage). */
export interface SlackCloudRelayMessage {
  id?: string;
  type: string;
  payload: unknown;
  fromDeviceName?: string;
}

/**
 * Slack Service singleton instance
 */
let slackServiceInstance: SlackService | null = null;

/**
 * Pull the Slack error code and message out of an error thrown by the Slack
 * SDK (or anything else).
 *
 * Platform errors carry the code in `data.error` ("invalid_auth",
 * "token_revoked", …); request errors carry the network cause in
 * `original.code` ("ECONNREFUSED", "ETIMEDOUT"); other SDK errors carry a
 * `code` string. Anything else reports "unknown".
 *
 * @param error - The thrown value
 * @returns The Slack error code (or network code) and the message
 *
 * @example
 * ```typescript
 * describeSlackError(platformError); // { code: 'invalid_auth', message: 'An API error occurred: invalid_auth' }
 * ```
 */
export function describeSlackError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const shape = error as {
    code?: unknown;
    data?: { error?: unknown };
    original?: { code?: unknown };
  } | null | undefined;
  const code =
    typeof shape?.data?.error === 'string' ? shape.data.error
    : typeof shape?.original?.code === 'string' ? shape.original.code
    : typeof shape?.code === 'string' ? shape.code
    : 'unknown';
  return { code, message };
}

/**
 * SlackService class for managing Slack bot operations
 */
export class SlackService extends EventEmitter {
  private logger = LoggerService.getInstance().createComponentLogger('SlackService');
  private app: SlackApp | null = null;
  private client: SlackWebClient | null = null;
  private config: SlackConfig | null = null;
  /** Bot user id from `auth.test`, cached by getBotUserId(). */
  private cachedBotUserId: string | null = null;
  /** Lower-cased handle/display name → Slack user id, filled by findUserByHandle(). */
  private userHandleCache: Map<string, string> = new Map();
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
  /** Inbound cloud events already handled, keyed `channel:ts:type` (a message reaches us once per app that can see it). */
  private seenInboundKeys: Map<string, number> = new Map();
  /** Whether an agent session runs on this instance (set by the initializer; agent-to-agent routing). */
  isLocalAgent: ((agentSession: string) => boolean) | null = null;
  /** Whether a Slack conversation belongs to an agent's own app (the master bot cannot post there). Set by the initializer. */
  isAgentOwnedConversation: ((channelId: string) => boolean) | null = null;
  /** Slack user id of the person who installed the app (owner notifications go to their DM). Set by the initializer. */
  getOwnerUserId: (() => string | null) | null = null;

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
  /** Inbound transport the service was initialised with */
  private transport: SlackTransport = 'socket';
  /** Relay source the cloud transport is attached to (see attachCloudTransport) */
  private cloudSource: SlackCloudEventSource | null = null;
  /** Bound relay listener so it can be detached */
  private cloudListener: ((msg: SlackCloudRelayMessage) => void) | null = null;

  /**
   * Initialize the Slack service with configuration
   *
   * With `config.transport === 'cloud'` no Socket Mode connection is opened:
   * Crewly Cloud owns the Slack app and pushes events through the relay (see
   * {@link attachCloudTransport}); only a Web API client is created for
   * outbound calls, and the service reports connected as soon as a bot
   * token is present.
   *
   * @param config - Slack bot configuration
   * @returns Promise that resolves when connected
   */
  async initialize(config: SlackConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.transport = config.transport ?? 'socket';

    if (this.transport === 'cloud') {
      await this.initializeCloudTransport(config);
      return;
    }

    try {
      // Dynamic import of @slack/bolt (CJS module requires default import handling).
      // Cache the constructor and LogLevel on first import for reuse in reconnect.
      const boltModule = await import('@slack/bolt') as Record<string, unknown>;
      const defaultExport = boltModule.default as Record<string, unknown> | undefined;
      const App = (boltModule.App ?? defaultExport?.App) as new (opts: Record<string, unknown>) => unknown;
      const LogLevel = (boltModule.LogLevel ?? defaultExport?.LogLevel) as Record<string, unknown> | undefined;
      this.cachedAppConstructor = App;
      this.cachedLogLevelEnum = LogLevel ?? null;

      // Verify the bot token BEFORE constructing the Bolt App — see
      // preflightBotToken() for why the App must never be built on an
      // unverified token. Throws into this catch on any failure.
      const identity = await this.preflightBotToken(config.botToken);

      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        signingSecret: config.signingSecret,
        socketMode: config.socketMode,
        logLevel: (LogLevel as Record<string, unknown>)?.INFO ?? 'info',
        ...identity,
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

        this.clearDegraded();
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
   * Resolve the `WebClient` constructor from `@slack/web-api`.
   *
   * `@slack/web-api` ships with Bolt; the dynamic import keeps the CJS/ESM
   * interop identical to the Bolt import in {@link initialize}.
   *
   * @returns The `WebClient` class
   */
  private async loadWebClientConstructor(): Promise<new (token: string) => unknown> {
    const webApiModule = (await import('@slack/web-api')) as Record<string, unknown>;
    const defaultExport = webApiModule.default as Record<string, unknown> | undefined;
    return (webApiModule.WebClient ?? defaultExport?.WebClient) as new (token: string) => unknown;
  }

  /**
   * Verify the bot token with `auth.test` BEFORE a Bolt App is built on it.
   *
   * Why this exists: `@slack/bolt` 3.x (`tokenVerificationEnabled` defaults
   * to true) calls `client.auth.test()` eagerly inside the App constructor
   * (`singleAuthorization` → `runAuthTestForBotToken`) and parks that promise
   * with no rejection handler until the first inbound event is authorized.
   * With a dead token the promise rejects a few hundred ms later with no
   * Crewly frame on its stack — an unhandled rejection that the process-level
   * handler treats as fatal once signal handlers are armed. Verifying first
   * means the App is never constructed on a bad token, so the parked promise
   * never exists. On success the ids are handed to Bolt, which then skips its
   * own `auth.test`: net API calls are unchanged (one `auth.test` either way).
   *
   * ANY failure — `invalid_auth`, `account_inactive`, `token_revoked`, or a
   * network error reaching Slack — marks the integration degraded and rethrows
   * so the caller's existing catch (initialize / attemptReconnect) tears down
   * cleanly. Nothing escapes past `connectSlack`.
   *
   * @param botToken - The bot token to verify
   * @returns Bot identity in the shape Bolt's App constructor accepts; empty
   *   when Slack omitted either id (Bolt then verifies on its own)
   * @throws The `auth.test` error, after the integration was marked degraded
   */
  private async preflightBotToken(botToken: string): Promise<{ botId?: string; botUserId?: string }> {
    let result: Awaited<ReturnType<SlackWebClient['auth']['test']>>;
    try {
      const WebClient = await this.loadWebClientConstructor();
      const probe = new WebClient(botToken) as unknown as SlackWebClient;
      result = await probe.auth.test();
    } catch (error) {
      this.markDegraded('auth.test failed before connect', error);
      throw error;
    }
    if (result?.user_id) this.cachedBotUserId = result.user_id;
    return result?.user_id && result?.bot_id
      ? { botUserId: result.user_id, botId: result.bot_id }
      : {};
  }

  /**
   * Record that Slack is offline because of a Slack-side failure, and log it
   * once at WARN. The backend keeps running; only Slack features are off.
   *
   * @param label - What was being attempted when Slack failed
   * @param error - The failure (Slack SDK error or anything thrown)
   */
  private markDegraded(label: string, error: unknown): void {
    const { code, message } = describeSlackError(error);
    this.status.degraded = true;
    this.status.degradedReason = code;
    this.status.lastError = message;
    this.status.lastErrorAt = new Date().toISOString();
    this.logger.warn(
      `Slack integration degraded: ${label} — Slack features are offline, the backend keeps running`,
      { code, error: message },
    );
  }

  /**
   * Clear the degraded flag after a successful connect.
   */
  private clearDegraded(): void {
    this.status.degraded = false;
    delete this.status.degradedReason;
  }

  /**
   * Cloud transport bootstrap: build a bare Web API client from the bot
   * token (no Bolt app, no socket, no reconnect loop). The bot user id from
   * the Cloud config seeds the cache so routing never needs `auth.test`.
   *
   * @param config - Config with `transport: 'cloud'`
   * @throws When the Web API client cannot be constructed
   */
  private async initializeCloudTransport(config: SlackConfig): Promise<void> {
    try {
      if (!config.botToken) {
        throw new Error('Cloud Slack config has no bot token');
      }
      const WebClient = await this.loadWebClientConstructor();
      this.app = null;
      this.client = new WebClient(config.botToken) as unknown as SlackWebClient;
      if (config.botUserId) this.cachedBotUserId = config.botUserId;
      this.status.connected = true;
      this.status.socketMode = false;
      this.clearDegraded();
      this.emit('connected');
      this.logger.info('Connected via Crewly Cloud transport (events arrive over the relay, no Socket Mode)');
    } catch (error) {
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
   * The inbound transport this service was initialised with.
   *
   * @returns `socket` (Bolt Socket Mode) or `cloud` (relay push)
   */
  getTransport(): SlackTransport {
    return this.transport;
  }

  /**
   * Shared inbound handler for both transports. Turns a raw Slack `message`
   * or `app_mention` event into a {@link SlackIncomingMessage}, applies the
   * allow-list, bumps counters and emits `message` — exactly what the Socket
   * Mode listeners did before the split, so a Cloud-pushed event routes the
   * same way as one received over the socket.
   *
   * @param event - Raw Slack event object
   * @param meta - Which transport delivered it (defaults to `socket`)
   * @returns The emitted message, or null when the event was dropped
   */
  handleInboundEvent(event: SlackRawInboundEvent, meta: SlackInboundMeta = { source: 'socket' }): SlackIncomingMessage | null {
    const config = this.config;
    if (!config) return null;

    const provenance: Pick<SlackIncomingMessage, 'source' | 'eventId' | 'agentSession' | 'authorAgentSession' | 'authorDisplayName'> = {
      source: meta.source,
      ...(meta.eventId ? { eventId: meta.eventId } : {}),
      ...(meta.agentSession ? { agentSession: meta.agentSession } : {}),
      ...(meta.authorAgentSession ? { authorAgentSession: meta.authorAgentSession, authorDisplayName: meta.authorDisplayName } : {}),
    };

    let incomingMessage: SlackIncomingMessage;

    if (event.type === 'app_mention') {
      if (!event.user || !event.channel) return null;
      if (!isUserAllowed(event.user, config)) {
        this.logger.info('Unauthorized user mention', { userId: event.user });
        return null;
      }
      incomingMessage = {
        id: event.ts ?? '',
        type: 'app_mention',
        text: event.text ?? '',
        userId: event.user,
        channelId: event.channel,
        threadTs: event.thread_ts,
        ts: event.ts ?? '',
        teamId: event.team || '',
        eventTs: event.event_ts ?? event.ts ?? '',
        ...provenance,
      };
    } else if (event.type === 'message') {
      // Allow messages with text or files (or both)
      if (!event.text && (!event.files || event.files.length === 0)) return null;
      if (!event.user || !event.channel) return null;

      // Bypass user permission check for cross-machine messages —
      // these come from other bots and are authenticated by device ID,
      // not Slack user ID. The CrossMachineMessageService handles its
      // own security (device identity, target filtering, deduplication).
      const isCrossMachine = !!event.text && event.text.startsWith(CROSS_MACHINE_PREFIX);

      // Check user permissions (skip for cross-machine messages and for
      // messages the account's own agents wrote — those are colleagues, not
      // Slack users on the allow-list)
      if (!isCrossMachine && !meta.authorAgentSession && !isUserAllowed(event.user, config)) {
        this.logger.info('Unauthorized user', { userId: event.user });
        return null;
      }

      // Pass ALL files through; downstream services handle image vs non-image distinction
      const allFiles = event.files || [];
      const imageFiles = allFiles.filter((f) => f.mimetype?.startsWith('image/'));

      incomingMessage = {
        id: event.ts || '',
        type: 'message',
        text: event.text || '',
        userId: event.user,
        channelId: event.channel,
        threadTs: event.thread_ts,
        ts: event.ts || '',
        teamId: event.team || '',
        eventTs: event.ts || '',
        files: allFiles.length > 0 ? allFiles : undefined,
        hasImages: imageFiles.length > 0,
        hasFiles: allFiles.length > 0,
        ...provenance,
      };
    } else {
      this.logger.debug('Ignoring unsupported inbound Slack event', { type: event.type, source: meta.source });
      return null;
    }

    this.status.messagesReceived++;
    this.status.lastEventAt = new Date().toISOString();
    this.emit('message', incomingMessage);
    return incomingMessage;
  }

  /**
   * Cloud transport entry point: unwrap a `slack_event` envelope and hand
   * the raw event to {@link handleInboundEvent}. Reproduces what Bolt does
   * for free on the socket path — its `ignoreSelf` middleware and the
   * subtype filtering — so the master bot never reacts to its own posts and
   * edits/joins/bot chatter never reach routing.
   *
   * @param envelope - The relay message `data`
   * @returns The emitted message, or null when dropped
   */
  handleCloudEnvelope(envelope: SlackCloudEventEnvelope): SlackIncomingMessage | null {
    const event = envelope?.event;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      this.logger.warn('Malformed slack_event envelope — dropped', { eventId: envelope?.eventId });
      return null;
    }
    const allowedSubtypes: readonly string[] = SLACK_CLOUD_CONSTANTS.INBOUND_ALLOWED_SUBTYPES;
    if (event.subtype && !allowedSubtypes.includes(event.subtype)) {
      this.logger.debug('Dropping Slack event subtype', { subtype: event.subtype, eventId: envelope.eventId });
      return null;
    }
    // Bolt's ignoreSelf equivalent: our own bot user's posts (replies the
    // orchestrator just sent) must not come back as inbound.
    if (this.cachedBotUserId && event.user === this.cachedBotUserId) {
      return null;
    }
    if (event.bot_id && !event.user) {
      return null;
    }
    // A message written by one of the account's agents: Cloud only forwards
    // these when they @-mention another agent. One from another machine is
    // a colleague and is delivered like a human's message. One written HERE
    // is delivered too when it @'s another local agent (three agents of one
    // team discussing in a thread) — the author is excluded downstream;
    // otherwise the author already has it in chat-v2 and it is dropped.
    if (envelope.authorAgentSession && this.isLocalAgent?.(envelope.authorAgentSession)) {
      const addressedLocal = (envelope.mentionedAgentSessions ?? []).some(
        (m) => m !== envelope.authorAgentSession && this.isLocalAgent?.(m),
      );
      if (!addressedLocal) return null;
    }
    // A per-agent app sees every channel it is a member of, so a team
    // channel message can reach Cloud once per agent app plus once from the
    // master app. Cloud keeps whichever copy arrives first — which may be
    // an agent app's — so every copy must be routable here; the first one
    // wins and later copies of the same message are dropped. (Dropping
    // agent-app copies outright lost the message whenever Cloud had
    // already discarded the master copy as a duplicate.)
    const isDm = event.channel_type ? event.channel_type === 'im' : !!event.channel?.startsWith('D');
    const ts = typeof event.ts === 'string' ? event.ts : typeof event.event_ts === 'string' ? event.event_ts : '';
    if (event.channel && ts) {
      const key = `${event.channel}:${ts}:${event.type}`;
      if (this.seenInboundKeys.has(key)) {
        this.logger.debug('Dropping repeated copy of an inbound Slack event', { eventId: envelope.eventId, key });
        return null;
      }
      this.seenInboundKeys.set(key, Date.now());
      if (this.seenInboundKeys.size > SLACK_DEDUP_CONSTANTS.MAX_TRACKED_MESSAGES) {
        const oldest = this.seenInboundKeys.keys().next().value;
        if (oldest !== undefined) this.seenInboundKeys.delete(oldest);
      }
    }
    return this.handleInboundEvent(event, {
      source: 'cloud',
      eventId: envelope.eventId,
      apiAppId: envelope.apiAppId,
      // The agent-session provenance only means "DM to this agent's bot";
      // a channel message seen through an agent app is an ordinary channel message.
      // Stripped back to the local name: the orchestrator is registered with
      // Cloud under a per-instance session so two machines on one account do
      // not share an app, and nothing on this side knows that spelling.
      agentSession:
        envelope.source === 'agent' && isDm && envelope.agentSession
          ? localAgentSession(envelope.agentSession)
          : undefined,
      ...(envelope.authorAgentSession ? { authorAgentSession: envelope.authorAgentSession, authorDisplayName: envelope.authorDisplayName } : {}),
    });
  }

  /**
   * Subscribe to a relay source (CloudSyncService) and route every
   * `slack_event` message into {@link handleCloudEnvelope}. Idempotent —
   * re-attaching replaces the previous subscription.
   *
   * @param source - Emitter of relay `message` events
   */
  attachCloudTransport(source: SlackCloudEventSource): void {
    this.detachCloudTransport();
    this.cloudListener = (msg: SlackCloudRelayMessage): void => {
      if (msg?.type !== SLACK_CLOUD_CONSTANTS.MESSAGE_TYPE) return;
      try {
        this.handleCloudEnvelope(msg.payload as SlackCloudEventEnvelope);
      } catch (err) {
        this.logger.warn('slack_event handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    source.on('message', this.cloudListener);
    this.cloudSource = source;
    this.logger.info('Cloud Slack transport attached to relay');
  }

  /** Undo {@link attachCloudTransport}. */
  detachCloudTransport(): void {
    if (this.cloudSource && this.cloudListener) {
      this.cloudSource.off('message', this.cloudListener);
    }
    this.cloudSource = null;
    this.cloudListener = null;
  }

  /**
   * Set up Slack event handlers
   */
  private setupEventHandlers(): void {
    if (!this.app || !this.config) return;

    // Handle direct messages
    this.app.message(async ({ message }) => {
      this.handleInboundEvent({ ...message, type: 'message' }, { source: 'socket' });
    });

    // Handle @mentions
    this.app.event('app_mention', async ({ event }) => {
      this.handleInboundEvent({ ...event, type: 'app_mention' }, { source: 'socket' });
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

      // Same pre-flight as initialize(): a token revoked since boot must
      // surface here as a (fatal) reconnect error, never as Bolt's parked
      // auth.test rejection escaping to the process.
      const identity = await this.preflightBotToken(this.config.botToken);

      this.app = new App({
        token: this.config.botToken,
        appToken: this.config.appToken,
        signingSecret: this.config.signingSecret,
        socketMode: this.config.socketMode,
        logLevel: (LogLevel as Record<string, unknown>)?.INFO ?? 'info',
        ...identity,
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
      this.clearDegraded();
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
        // Per-agent identity for team channels. A real agent bot token wins
        // (the message is posted by that bot user); otherwise the cosmetic
        // username/icon override. Only sent when set so the orchestrator's
        // plain posts keep the app's default bot identity.
        ...(message.botToken
          ? { token: message.botToken }
          : {
              ...(message.username ? { username: message.username } : {}),
              ...(message.iconEmoji
                ? { icon_emoji: message.iconEmoji }
                : message.iconUrl
                  ? { icon_url: message.iconUrl }
                  : {}),
            }),
      });

      this.status.messagesSent++;

      // Track this fingerprint for future dedup
      this.trackMessageFingerprint(fingerprint, now);

      // Mirror the outbound reply into chat-v2 so the Slack thread shows both
      // sides ("收和发") in the consolidated chat. Best-effort, thread-only.
      if (message.threadTs && !message.skipChatV2Mirror) {
        void this.recordOutboundToChatV2(message);
      }

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
   * Mirror an outbound Slack reply into the canonical chat-v2 store so the
   * Slack thread shows both inbound (user) and outbound (agent) messages in
   * the consolidated /team-chat surface. Records against the SAME channel the
   * inbound persisted to — `synthesizeSlackConversationId(channelId, threadTs)`.
   *
   * Best-effort: dynamic imports + try/catch so a chat-v2 failure never
   * affects Slack delivery. Only called for threaded replies (threadTs set).
   *
   * @param message - The outbound Slack message that was just sent.
   */
  private async recordOutboundToChatV2(message: SlackOutgoingMessage): Promise<void> {
    try {
      if (!message.channelId || !message.threadTs || !(message.text ?? '').trim()) return;
      const [{ getChatV2Service }, { synthesizeSlackConversationId, slackOutboundClientMessageId }] =
        await Promise.all([
          import('../chat-v2/chat-v2.singleton.js'),
          import('../chat-v2/legacy-dto.utils.js'),
        ]);
      const chatV2 = getChatV2Service();
      const conversationId = synthesizeSlackConversationId(message.channelId, message.threadTs);
      const channel = chatV2.ensureChannelForLegacyConversation({
        conversationId,
        agentSession: ORCHESTRATOR_SESSION_NAME,
      });
      chatV2.recordTurn({
        channelId: channel.id,
        senderType: 'agent',
        senderId: channel.agentSession || ORCHESTRATOR_SESSION_NAME,
        content: message.text,
        // Shared idempotency key with the /slack/send bookkeeping path so the
        // same reply isn't persisted twice (duplicate bubbles in the merged
        // Orchestrator timeline).
        clientMessageId: slackOutboundClientMessageId(
          message.channelId,
          message.threadTs,
          message.text,
        ),
        metadata: {
          source: 'slack',
          slackChannelId: message.channelId,
          slackThreadTs: message.threadTs,
        },
      });
    } catch (err) {
      this.logger.warn('Failed to mirror outbound Slack message to chat-v2', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    // Two agents saying the same thing in the same thread are two messages,
    // so the sender identity is part of the key.
    const sender = message.botToken ? `bot:${message.botToken.slice(-8)}` : message.username || '';
    return `${message.channelId}:${message.threadTs || ''}:${sender}:${hash}`;
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
    const blocks = this.formatNotificationBlocks(notification);
    const text = `${notification.title}: ${notification.message}`;
    const explicit = notification.channelId || this.config?.defaultChannelId;
    if (explicit) {
      await this.sendMessage({ channelId: explicit, text, blocks, threadTs: notification.threadTs });
      return;
    }
    // No SLACK_DEFAULT_CHANNEL: deliver where the owner last talked to us
    // (only worth trying on a live connection). Conversations owned by an
    // agent's own app are skipped — the master bot cannot post there — and
    // a candidate that still fails (channel_not_found, not_in_channel) is
    // passed over for the next one.
    if (!this.isConnected()) {
      this.logger.warn('No channel configured for notification');
      return;
    }
    // Owner notifications are for the owner: a DM with the master bot, never
    // a team channel (those belong to the agents and their humans — a boot
    // banner or an OKR nudge in #course-standardization-team is noise to
    // everyone there). Candidates: a DM opened with the person who installed
    // the app first (the one channel guaranteed to belong to this workspace),
    // then the most recent master-bot DMs — thread dirs can be left over from
    // an earlier workspace binding and fail with channel_not_found.
    const isAgentDm = (id: string) => !!this.isAgentOwnedConversation?.(id);
    const candidates: string[] = [];
    const ownerId = this.getOwnerUserId?.() ?? null;
    if (ownerId) {
      try {
        candidates.push(await this.openDirectMessage(ownerId));
      } catch (err) {
        this.logger.debug('Could not open a DM with the workspace owner for the notification', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const id of resolveFallbackNotificationChannels(undefined, (id) => !id.startsWith('D') || isAgentDm(id))
      .slice(0, SLACK_NOTIFICATION_FALLBACK_MAX_CANDIDATES)) {
      if (!candidates.includes(id)) candidates.push(id);
    }
    if (candidates.length === 0) {
      this.logger.warn('No channel configured for notification — set SLACK_DEFAULT_CHANNEL or DM the Crewly bot once');
      return;
    }
    let lastError: unknown = null;
    for (const channelId of candidates) {
      try {
        await this.sendMessage({ channelId, text, blocks, threadTs: notification.threadTs, skipChatV2Mirror: true });
        this.logger.info('No default channel; notification sent to the most recent reachable thread channel', { channelId });
        return;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/channel_not_found|not_in_channel|is_archived/.test(msg)) throw err;
        this.logger.debug('Notification fallback channel unreachable — trying the next one', { channelId, error: msg });
      }
    }
    this.logger.warn('No reachable channel for notification — set SLACK_DEFAULT_CHANNEL or DM the Crewly bot once', {
      tried: candidates.length,
      error: lastError instanceof Error ? lastError.message : String(lastError),
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
   * @param botToken - Optional per-agent bot token (edit a message that bot posted)
   */
  async updateMessage(
    channelId: string,
    messageTs: string,
    text: string,
    blocks?: SlackBlock[],
    botToken?: string
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    await this.client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks,
      ...(botToken ? { token: botToken } : {}),
    });
  }

  /**
   * Add a reaction to a message
   *
   * @param channelId - Channel ID
   * @param messageTs - Message timestamp
   * @param emoji - Emoji name (without colons)
   * @param botToken - Optional per-agent bot token (react in that bot's own DMs)
   */
  async addReaction(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    await this.client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: emoji,
      // An agent's own bot reacts in conversations the master bot cannot see (its DMs).
      ...(botToken ? { token: botToken } : {}),
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
   * Resolve the bot user's Slack id (`U…`) via `auth.test`, cached after the
   * first call. Team-channel routing uses it to ignore `<@bot>` mentions in
   * inbound text and to invite the bot into linked channels.
   *
   * @returns The bot user id, or null when not connected or the API omits it
   */
  async getBotUserId(): Promise<string | null> {
    if (this.cachedBotUserId) return this.cachedBotUserId;
    if (!this.client) return null;
    try {
      const res = await this.client.auth.test();
      const id = res?.user_id ?? null;
      if (id) this.cachedBotUserId = id;
      return id;
    } catch (error) {
      this.logger.warn('auth.test failed while resolving bot user id', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create a public Slack channel. When Slack reports `name_taken`, the
   * existing channel of that name is looked up and returned instead, so a
   * team whose channel already exists (e.g. after a re-install) links to
   * it rather than failing.
   *
   * Requires the `channels:manage` scope (and `channels:read` for the
   * name-taken fallback).
   *
   * @param name - Channel name without `#`, already sanitised by the caller
   * @returns The created (or pre-existing) channel
   * @throws Error when the client is not initialised or Slack refuses
   */
  async createChannel(name: string): Promise<SlackChannelInfo> {
    const conversations = this.requireConversationsApi();
    try {
      const res = await conversations.create({ name, is_private: false });
      const channel = SlackService.toChannelInfo(res.channel);
      if (!channel) throw new Error('conversations.create returned no channel');
      return channel;
    } catch (error) {
      if (SlackService.slackErrorCode(error) === 'name_taken') {
        const existing = await this.findChannelByName(name);
        if (existing) {
          // The bot may not be in a channel it did not create; joining is
          // idempotent and needed before it can post or read there.
          await this.joinChannel(existing.id).catch(() => undefined);
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Rename a channel.
   *
   * Used to keep an auto-created team channel in step with its Crewly team:
   * renaming the team used to leave the channel on its old name forever
   * (2026-09-20).
   *
   * Requires the `channels:manage` scope.
   *
   * @param channelId - The channel to rename
   * @param name - New name without `#`, already sanitised by the caller
   * @returns The channel's name after the call, or null when Slack refused
   *   for a reason worth living with — the name is already taken, or the bot
   *   is not allowed to rename this channel. A failed rename must never fail
   *   the team update that triggered it.
   */
  async renameChannel(channelId: string, name: string): Promise<string | null> {
    const conversations = this.requireConversationsApi();
    if (!conversations.rename) {
      this.logger.warn('This Slack client cannot rename channels', { channelId, name });
      return null;
    }
    try {
      const res = await conversations.rename({ channel: channelId, name });
      return SlackService.toChannelInfo(res.channel)?.name ?? name;
    } catch (error) {
      const code = SlackService.slackErrorCode(error);
      // Renaming needs membership, and the bot is not always in a channel it
      // made: re-installing the app drops it out of every one of them, so
      // after a reinstall thirteen team channels answered `not_in_channel`
      // (owner, 2026-09-21). A public channel it may rejoin by itself; a
      // private one has to be invited, so that case stays a refusal.
      if (code === 'not_in_channel') {
        try {
          await this.joinChannel(channelId);
          const res = await conversations.rename({ channel: channelId, name });
          this.logger.info('Rejoined a channel to rename it', { channelId, name });
          return SlackService.toChannelInfo(res.channel)?.name ?? name;
        } catch (retryError) {
          this.logger.warn('Could not rename the Slack channel after rejoining', {
            channelId,
            name,
            code: SlackService.slackErrorCode(retryError),
          });
          return null;
        }
      }
      this.logger.warn('Could not rename the Slack channel', { channelId, name, code });
      return null;
    }
  }

  /**
   * Find a public or private channel by exact name (case-insensitive),
   * paging through `conversations.list`.
   *
   * @param name - Channel name without `#`
   * @returns The channel, or null when no channel has that name
   */
  async findChannelByName(name: string): Promise<SlackChannelInfo | null> {
    const conversations = this.requireConversationsApi();
    const wanted = name.toLowerCase();
    let cursor: string | undefined;
    // Bounded paging so a pathological workspace cannot spin forever.
    for (let page = 0; page < 20; page++) {
      const res = await conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
        cursor,
        exclude_archived: false,
      });
      for (const raw of res.channels ?? []) {
        if ((raw.name ?? '').toLowerCase() === wanted) {
          return SlackService.toChannelInfo(raw);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return null;
  }

  /**
   * Fetch a channel by id.
   *
   * @param channelId - Slack channel id
   * @returns The channel, or null when Slack reports `channel_not_found`
   */
  async getChannelInfo(channelId: string): Promise<SlackChannelInfo | null> {
    const conversations = this.requireConversationsApi();
    try {
      const res = await conversations.info({ channel: channelId });
      return SlackService.toChannelInfo(res.channel);
    } catch (error) {
      if (SlackService.slackErrorCode(error) === 'channel_not_found') return null;
      throw error;
    }
  }

  /**
   * Join a public channel as the bot (idempotent). Requires `channels:join`.
   *
   * @param channelId - Slack channel id
   */
  async joinChannel(channelId: string): Promise<void> {
    const conversations = this.requireConversationsApi();
    await conversations.join({ channel: channelId });
  }

  /**
   * Invite users (or other bots) into a channel the bot is a member of.
   *
   * @param channelId - Slack channel id
   * @param userIds - Slack user ids to invite
   */
  async inviteToChannel(channelId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const conversations = this.requireConversationsApi();
    await conversations.invite({ channel: channelId, users: userIds.join(',') });
  }

  /**
   * Set a channel's purpose line. Requires `channels:manage`.
   *
   * @param channelId - Slack channel id
   * @param purpose - Purpose text (Slack caps it at 250 chars)
   */
  async setChannelPurpose(channelId: string, purpose: string): Promise<void> {
    const conversations = this.requireConversationsApi();
    await conversations.setPurpose({
      channel: channelId,
      purpose: purpose.slice(0, SLACK_TEAM_CHANNEL_CONSTANTS.MAX_PURPOSE_LENGTH),
    });
  }

  /**
   * Archive a channel. `already_archived` is treated as success so the
   * team-deleted path is idempotent.
   *
   * @param channelId - Slack channel id
   */
  async archiveChannel(channelId: string): Promise<void> {
    const conversations = this.requireConversationsApi();
    try {
      await conversations.archive({ channel: channelId });
    } catch (error) {
      const code = SlackService.slackErrorCode(error);
      if (code === 'already_archived' || code === 'channel_not_found') return;
      throw error;
    }
  }

  /**
   * Open (or reuse) the DM channel with a person and return its id.
   *
   * Requires `im:write` on the token used. Pass `botToken` to open the DM as
   * an agent's own bot user — that is a different conversation from the one
   * the default Crewly bot has with the same person.
   *
   * @param userId - Slack user id of the person (`U…` / `W…`)
   * @param botToken - Optional per-call token override
   * @returns The DM channel id (`D…`)
   * @throws Error when the client is not initialised or Slack refuses
   */
  async openDirectMessage(userId: string, botToken?: string): Promise<string> {
    const conversations = this.requireConversationsApi();
    const res = await conversations.open({
      users: userId,
      ...(botToken ? { token: botToken } : {}),
    });
    const id = res.channel?.id;
    if (!id) throw new Error(`conversations.open returned no channel for ${userId}`);
    return id;
  }

  /**
   * Resolve an `@handle` (or display / real name) to a Slack user id by
   * scanning the directory. Results are cached for the process lifetime —
   * handles change rarely and the listing is expensive.
   *
   * Bots and deactivated accounts are skipped so `@sam` never resolves to a
   * bot that happens to share the name.
   *
   * @param handle - Handle without `@`, case-insensitive
   * @returns The user id, or null when nobody matches
   * @throws Error when the client is not initialised or lacks `users:read`
   */
  async findUserByHandle(handle: string): Promise<string | null> {
    const wanted = (handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!wanted) return null;
    const cached = this.userHandleCache.get(wanted);
    if (cached) return cached;
    if (!this.client) throw new Error('Slack client not initialized');
    const list = this.client.users.list;
    if (!list) throw new Error('Slack client has no users.list API');

    let cursor: string | undefined;
    // Bounded paging: a very large workspace should fail loudly rather than
    // spin through the whole directory on every miss.
    for (let page = 0; page < 20; page++) {
      const res = await list({ limit: 200, cursor });
      for (const member of res.members ?? []) {
        if (!member.id || member.deleted || member.is_bot) continue;
        const names = [member.name, member.profile?.display_name, member.profile?.real_name, member.real_name]
          .filter((n): n is string => !!n)
          .map((n) => n.toLowerCase());
        for (const n of names) {
          if (!this.userHandleCache.has(n)) this.userHandleCache.set(n, member.id);
        }
        if (names.includes(wanted)) return member.id;
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return null;
  }

  /**
   * The conversations API of the live client, or throw when Slack is not
   * initialised. Centralised so every channel helper reports the same
   * error text.
   */
  private requireConversationsApi(): NonNullable<SlackWebClient['conversations']> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }
    if (!this.client.conversations) {
      throw new Error('Slack client has no conversations API');
    }
    return this.client.conversations;
  }

  /**
   * Extract Slack's machine-readable error code (`name_taken`,
   * `channel_not_found`, …) from a thrown Web API error.
   *
   * @param error - The caught value
   * @returns The code, or null when the error carries none
   */
  static slackErrorCode(error: unknown): string | null {
    const data = (error as { data?: { error?: string } } | null)?.data;
    return typeof data?.error === 'string' ? data.error : null;
  }

  /**
   * Normalise a raw conversations-API channel object.
   *
   * @param raw - Slack's channel object
   * @returns The trimmed descriptor, or null when the id is missing
   */
  private static toChannelInfo(raw: RawSlackChannel | undefined): SlackChannelInfo | null {
    if (!raw?.id) return null;
    return {
      id: raw.id,
      name: raw.name ?? '',
      isArchived: raw.is_archived === true,
      isPrivate: raw.is_private === true,
    };
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
    this.detachCloudTransport();
    if (this.app) {
      await this.app.stop();
      this.status.connected = false;
      this.emit('disconnected');
      this.logger.info('Disconnected');
    } else if (this.transport === 'cloud' && this.client) {
      this.client = null;
      this.status.connected = false;
      this.emit('disconnected');
      this.logger.info('Disconnected (cloud transport)');
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
  async getFileInfo(fileId: string, botToken?: string): Promise<{ url_private: string; url_private_download: string }> {
    if (!this.client) {
      throw new Error('Slack client not initialized');
    }

    // A file posted in a private channel is only visible to an app that is
    // in that channel. When the event reached us through an agent's own
    // Slack app, that app is the one with access — the workspace bot may
    // never have been invited (2026-09-20, #steamfun-portal).
    const result = await this.client.files.info({ file: fileId, ...(botToken ? { token: botToken } : {}) });
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
  /**
   * Member user ids of a channel, bots included (`conversations.members`,
   * paginated).
   *
   * @param channelId - Slack channel id
   * @returns User ids; empty when the bot is not in the channel
   */
  async listChannelMembers(channelId: string): Promise<string[]> {
    const conversations = this.requireConversationsApi();
    if (!conversations.members) throw new Error('Slack client has no conversations.members');
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await conversations.members({ channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const id of res.members ?? []) out.push(id);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /**
   * A user's display name and whether it is a bot (`users.info`).
   *
   * @param userId - Slack user id
   * @returns Name + bot flag, or null when Slack does not know the id
   */
  async getUserBasic(userId: string): Promise<{ name: string; isBot: boolean } | null> {
    if (!this.client) throw new Error('Slack client not initialized');
    try {
      const res = await this.client.users.info({ user: userId });
      const u = res.user;
      if (!u) return null;
      const name = u.profile?.display_name || u.real_name || u.name || userId;
      return { name, isBot: !!u.is_bot || u.id === 'USLACKBOT' };
    } catch {
      return null;
    }
  }

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

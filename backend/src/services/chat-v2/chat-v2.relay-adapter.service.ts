/**
 * ChatV2RelayAdapter — bridge between the local chat-v2 service and the
 * Cloud relay queue.
 *
 * Two responsibilities:
 *
 * 1. **Inbound RPC** — when a `chat_request` message lands on the local
 *    inbound queue, dispatch the named method against ChatV2Service (with
 *    the supplied `directory` / `presence` providers for the OSS-only
 *    methods), then return a `chat_response` to the originating device.
 *
 * 2. **Outbound events** — register an `onBroadcast` listener on
 *    {@link ChatV2Gateway} so every local broadcast (user message + agent
 *    reply) is also forwarded as a `chat_event` to all *known Portal
 *    devices* (devices that have issued a `chat_request` to this OSS
 *    recently). That keeps Portal UI in lockstep with the local one
 *    without any additional polling on Portal beyond its existing
 *    `/queue/poll` loop.
 *
 * Design notes:
 *   - Closed-set method dispatch via the {@link CHAT_RPC_METHODS} table;
 *     unknown methods produce `unsupported_method` errors so Portal sees
 *     a structured response rather than a hang.
 *   - Portal-device tracking is in-memory with an idle TTL (10 min).
 *     A Portal that sits silent for >TTL stops receiving chat_events;
 *     its next chat_request re-registers it. Survives across local OSS
 *     restarts via re-registration on the first chat_request, no
 *     persistence required.
 *   - Errors from ChatV2Service (ChatError) propagate verbatim via the
 *     response envelope so Portal can render the same error UX as the
 *     local OSS UI does on the REST surface.
 *
 * @module services/chat-v2/chat-v2.relay-adapter.service
 */

import type { EventEmitter } from 'events';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import {
  CHAT_RPC_METHODS,
  isChatRequestPayload,
  type ChatRequestPayload,
  type ChatResponsePayload,
  type ChatEventPayload,
  type ChatRpcMethod,
  type IncomingMessage,
} from '../cloud/cloud-sync.types.js';
import {
  ChatError,
  CHAT_ERROR_CODES,
  type ChatChannelDTO,
  type ChatMessageDTO,
  type ChatPrincipal,
} from './types.js';
import type { ChatV2Service } from './chat-v2.service.js';
import type {
  IAgentDirectoryProvider,
  IAgentPresenceProvider,
} from '../../controllers/chat-v2/chat-v2.controller.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Wire frame produced by {@link ChatV2Gateway.broadcast} — duplicated here
 * as `unknown`-typed in the relay payload so this module doesn't have to
 * pull in the WebSocket layer's types. We only forward; we do not inspect.
 */
type GatewayWireEvent = unknown;

/**
 * Minimal CloudSyncService surface the adapter depends on. Declared
 * narrowly so tests can stub a fake sync without spinning up the real
 * polling loop / fetch lifecycle.
 */
export interface ICloudSyncLike extends EventEmitter {
  sendMessage(
    toDeviceId: string,
    type: 'chat_response' | 'chat_event',
    payload: unknown,
  ): Promise<void>;
  /**
   * Optional queueId-direct send. When present, the adapter prefers it
   * for chat_response routing — Portal's queueId may not yet be in the
   * 30s device-poll cache, and the production relay routes by queueId
   * anyway. Methods without this fall back to sendMessage (stub-friendly).
   */
  sendToPeerQueueId?(
    peerQueueId: string,
    type: 'chat_response' | 'chat_event',
    payload: unknown,
  ): Promise<void>;
}

/**
 * Minimal ChatV2Gateway surface the adapter depends on — only the
 * `onBroadcast` listener registration.
 */
export interface IChatV2GatewayLike {
  onBroadcast(
    listener: (channelId: string, event: GatewayWireEvent) => void,
  ): () => void;
}

/**
 * Minimal ChatV2DispatcherService surface. Required for the
 * `sendMessage` RPC method — when Portal sends a user message via the
 * relay, the adapter persists it (via ChatV2Service) AND fires the
 * dispatcher so the bound agent's PTY actually receives a
 * `[CHAT:<id>]` prompt. The HTTP controller does the same thing for
 * local /agents traffic; this brings the relay path to parity.
 */
export interface IChatV2DispatcherLike {
  dispatchMessage(
    channel: ChatChannelDTO,
    message: ChatMessageDTO,
  ): Promise<unknown>;
}

/** Constructor options for {@link ChatV2RelayAdapter}. */
export interface ChatV2RelayAdapterOptions {
  /** The chat service to dispatch RPC calls against. */
  service: ChatV2Service;
  /** The gateway whose broadcasts we mirror to the relay. */
  gateway: IChatV2GatewayLike;
  /** Cloud sync — used both to listen for chat_request and to send replies. */
  cloudSync: ICloudSyncLike;
  /**
   * Optional ChatV2 dispatcher — fired after a Portal-sourced user
   * `sendMessage` RPC so the bound agent's PTY receives the
   * `[CHAT:<id>]` prompt (mirrors the HTTP controller's post-ack path).
   * When omitted (REST-only tests), Portal messages persist but agents
   * don't react — verify carefully before relying on this fallback.
   */
  dispatcher?: IChatV2DispatcherLike;
  /** Directory provider — backs the `listAgents` RPC method. */
  directory?: IAgentDirectoryProvider;
  /** Presence provider — backs the `getAgentPresence` RPC method. */
  presence?: IAgentPresenceProvider;
  /**
   * Idle TTL for Portal device registration (defaults to 10 min). A
   * Portal device that sits silent longer than this stops receiving
   * forwarded chat_events; the next chat_request re-registers it.
   * Override only in tests.
   */
  portalIdleTtlMs?: number;
  /** Optional logger override (defaults to a fresh component logger). */
  logger?: ComponentLogger;
  /** Optional clock for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Portal heartbeat — if a Portal hasn't issued any chat_request within this window, drop it. */
const DEFAULT_PORTAL_IDLE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wraps a ChatV2Service so it can be driven over the Cloud relay queue
 * from Cloud Portal. Single instance per running OSS process; instantiated
 * by `index.ts` once both the gateway and the cloud sync are ready.
 */
export class ChatV2RelayAdapter {
  private readonly service: ChatV2Service;
  private readonly gateway: IChatV2GatewayLike;
  private readonly cloudSync: ICloudSyncLike;
  private readonly dispatcher?: IChatV2DispatcherLike;
  private readonly directory?: IAgentDirectoryProvider;
  private readonly presence?: IAgentPresenceProvider;
  private readonly portalIdleTtlMs: number;
  private readonly logger: ComponentLogger;
  private readonly now: () => number;

  /** deviceId → last-seen ms timestamp; used for the portal-idle-TTL filter. */
  private readonly knownPortals: Map<string, number> = new Map();

  /** Cached unsubscribe hooks so {@link stop} can detach cleanly. */
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeBroadcast: (() => void) | null = null;

  constructor(options: ChatV2RelayAdapterOptions) {
    this.service = options.service;
    this.gateway = options.gateway;
    this.cloudSync = options.cloudSync;
    this.dispatcher = options.dispatcher;
    this.directory = options.directory;
    this.presence = options.presence;
    this.portalIdleTtlMs = options.portalIdleTtlMs ?? DEFAULT_PORTAL_IDLE_TTL_MS;
    this.logger =
      options.logger ??
      LoggerService.getInstance().createComponentLogger('ChatV2RelayAdapter');
    this.now = options.now ?? Date.now;
  }

  /**
   * Wire the adapter to the cloud-sync inbound stream and the gateway's
   * broadcast hook. Idempotent — calling twice is a logged no-op so the
   * server bootstrap can be safe under partial restart sequences.
   */
  start(): void {
    if (this.unsubscribeMessage || this.unsubscribeBroadcast) {
      this.logger.warn('ChatV2RelayAdapter.start called twice — ignoring');
      return;
    }
    const messageHandler = (msg: IncomingMessage): void => {
      if (msg.type !== 'chat_request') return;
      // Fire-and-forget; errors are caught inside handleRequest.
      void this.handleRequest(msg);
    };
    this.cloudSync.on('message', messageHandler);
    this.unsubscribeMessage = () => {
      this.cloudSync.off('message', messageHandler);
    };

    this.unsubscribeBroadcast = this.gateway.onBroadcast((channelId, event) =>
      this.handleBroadcast(channelId, event),
    );

    this.logger.info('ChatV2RelayAdapter started', {
      portalIdleTtlMs: this.portalIdleTtlMs,
    });
  }

  /** Detach all listeners. Safe to call during shutdown. */
  stop(): void {
    if (this.unsubscribeMessage) {
      this.unsubscribeMessage();
      this.unsubscribeMessage = null;
    }
    if (this.unsubscribeBroadcast) {
      this.unsubscribeBroadcast();
      this.unsubscribeBroadcast = null;
    }
    this.knownPortals.clear();
    this.logger.info('ChatV2RelayAdapter stopped');
  }

  /**
   * Number of currently-tracked Portal devices. Exposed for tests and
   * future observability dashboards (e.g. `/api/cloud/status`).
   */
  knownPortalCount(): number {
    this.pruneExpiredPortals();
    return this.knownPortals.size;
  }

  // -------------------------------------------------------------------------
  // Inbound request handling
  // -------------------------------------------------------------------------

  /**
   * Wrap {@link dispatchRpc} with the request-envelope unwrap and reply
   * round-trip. Always resolves; any error is mapped to a structured
   * `chat_response` so Portal never hangs on a missing reply.
   *
   * @param msg - Raw IncomingMessage from CloudSyncService
   */
  private async handleRequest(msg: IncomingMessage): Promise<void> {
    // The production relay's `/queue/poll` response only returns
    // `{id, payload, createdAt}` — sender info is dropped. To route the
    // `chat_response` back to Portal, we fall back to `msg.fromDeviceName`
    // (preserved verbatim from the sender's wrapper), where Portal stamps
    // its own queueId. See `relay-chat-client.ts:sendOverRelay`.
    const fromDevice = msg.from || msg.fromDeviceName || '';
    if (!fromDevice) {
      this.logger.warn('chat_request missing sender id (from + fromDeviceName both empty) — dropping', {
        msgId: msg.id,
      });
      return;
    }
    if (!isChatRequestPayload(msg.payload)) {
      this.logger.warn('chat_request payload failed validation — dropping', {
        fromDevice,
      });
      return;
    }
    const req = msg.payload as ChatRequestPayload;
    // Register the sender as a known Portal so future broadcasts fan to it.
    this.knownPortals.set(fromDevice, this.now());

    let response: ChatResponsePayload;
    try {
      const result = await this.dispatchRpc(req.method, req.params, fromDevice);
      response = { id: req.id, result };
    } catch (err) {
      response = {
        id: req.id,
        error: this.errorEnvelope(err),
      };
    }

    try {
      // Prefer the queueId-direct path when available — Portal's deviceId
      // == its relay queueId, and that bypasses CloudSyncService's stale
      // 30s device cache (Portal may have registered moments ago, faster
      // than the poll cadence).
      if (typeof this.cloudSync.sendToPeerQueueId === 'function') {
        await this.cloudSync.sendToPeerQueueId(fromDevice, 'chat_response', response);
      } else {
        await this.cloudSync.sendMessage(fromDevice, 'chat_response', response);
      }
    } catch (err) {
      // If we can't reply, log it — Portal will retry the request on
      // timeout. We can't surface the failure any other way (the
      // originator is the relay, not a connected socket here).
      this.logger.warn('Failed to send chat_response — Portal will retry on timeout', {
        fromDevice,
        method: req.method,
        requestId: req.id,
        error: formatError(err),
      });
    }
  }

  /**
   * Dispatch one of the closed-set RPC methods. Each branch maps to the
   * equivalent ChatV2Service / directory / presence call.
   *
   * Auth model: the originating Portal device shares an account with this
   * OSS (the relay's `userId` check guarantees it), so we build a
   * `ChatPrincipal` from the OSS's local owner id. Portal cannot
   * impersonate other users — that's enforced at the relay layer.
   *
   * @param method - One of {@link CHAT_RPC_METHODS}
   * @param params - Method-specific args
   * @param fromDevice - The originating Portal device id (for audit)
   * @returns The method-specific result (any JSON-serializable value)
   */
  private async dispatchRpc(
    method: string,
    params: Record<string, unknown> | undefined,
    fromDevice: string,
  ): Promise<unknown> {
    if (!(CHAT_RPC_METHODS as readonly string[]).includes(method)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unsupported_method: ${method}`,
      );
    }
    const principal = this.buildPrincipal();
    const p = params ?? {};
    switch (method as ChatRpcMethod) {
      case 'listAgents': {
        if (!this.directory) {
          throw new ChatError(
            CHAT_ERROR_CODES.INTERNAL,
            503,
            'directory_unavailable',
          );
        }
        const teams = await this.directory.getTeams();
        const agents: Array<{
          agentSession: string;
          name: string;
          role: string;
          teamId: string;
          teamName: string;
          agentStatus: string;
          workingStatus: string;
          avatar?: string;
        }> = [];
        for (const team of teams) {
          for (const member of team.members) {
            agents.push({
              agentSession: member.sessionName,
              name: member.name,
              role: member.role,
              teamId: team.id,
              teamName: team.name,
              agentStatus: member.agentStatus,
              workingStatus: member.workingStatus,
              avatar: member.avatar,
            });
          }
        }
        return { agents };
      }
      case 'getAgentPresence': {
        if (!this.presence) {
          throw new ChatError(
            CHAT_ERROR_CODES.INTERNAL,
            503,
            'presence_unavailable',
          );
        }
        const agentId = this.requireString(p, 'agentId');
        return this.presence.getPresence(agentId);
      }
      case 'listChannels': {
        const channels = this.service.listChannels({
          principal,
          includeArchived: p['includeArchived'] === true,
          limit: this.optionalNumber(p, 'limit'),
          type: p['type'] as 'dm' | 'channel' | undefined,
          teamId: this.optionalString(p, 'teamId'),
        });
        return { channels, nextCursor: null };
      }
      case 'ensureDmChannel': {
        const result = this.service.ensureDmChannel({
          agentSession: this.requireString(p, 'agentSession'),
          name: this.optionalString(p, 'name'),
          purpose: this.optionalString(p, 'purpose'),
          principal,
        });
        return this.serializeChannel(result.channel);
      }
      case 'createChannel': {
        const channel = this.service.createChannel({
          agentSession: this.optionalString(p, 'agentSession'),
          name: this.requireString(p, 'name'),
          purpose: this.optionalString(p, 'purpose'),
          principal,
          type: p['type'] as 'dm' | 'channel' | undefined,
          teamId: this.optionalString(p, 'teamId'),
          projectId: this.optionalString(p, 'projectId'),
          targetMemberId: this.optionalString(p, 'targetMemberId'),
        });
        return this.serializeChannel(channel);
      }
      case 'listMessages': {
        const result = this.service.listMessages({
          channelId: this.requireString(p, 'channelId'),
          principal,
          cursor: this.optionalString(p, 'cursor') ?? null,
          limit: this.optionalNumber(p, 'limit'),
          direction: p['direction'] === 'forward' ? 'forward' : 'backward',
        });
        return result;
      }
      case 'sendMessage': {
        const message = this.service.sendMessage({
          channelId: this.requireString(p, 'channelId'),
          principal,
          content: this.requireString(p, 'content'),
          contentType: p['contentType'] as 'text' | 'markdown' | undefined,
          clientMessageId: this.optionalString(p, 'clientMessageId'),
          attachments: [],
          mentions: Array.isArray(p['mentions'])
            ? (p['mentions'] as string[])
            : undefined,
          threadId: this.optionalString(p, 'threadId'),
        });
        // Fire-and-forget dispatch: mirror the HTTP controller's post-ack
        // path so the bound agent's PTY receives a `[CHAT:<id>]` prompt.
        // Without this, Portal-sent user messages persist but agents
        // never react — the user sees nothing back.
        if (this.dispatcher && message.senderType === 'user') {
          try {
            const channel = this.service.getChannel(message.channelId, principal);
            void this.dispatcher
              .dispatchMessage(channel, message)
              .catch((err) => {
                this.logger.warn('Portal-relay dispatch threw (non-fatal)', {
                  channelId: message.channelId,
                  error: formatError(err),
                });
              });
          } catch (err) {
            this.logger.warn('Portal-relay dispatch — getChannel failed (non-fatal)', {
              channelId: message.channelId,
              error: formatError(err),
            });
          }
        }
        return this.serializeMessage(message, fromDevice);
      }
      default: {
        // Unreachable given CHAT_RPC_METHODS check above, but TypeScript
        // exhaustiveness check needs the explicit throw.
        throw new ChatError(
          CHAT_ERROR_CODES.INTERNAL,
          500,
          `unhandled_method: ${method}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Outbound event handling
  // -------------------------------------------------------------------------

  /**
   * Fan a gateway broadcast out to every currently-known Portal device.
   * Drops expired (idle > TTL) entries inline so the set self-cleans.
   *
   * @param channelId - The channel whose timeline changed
   * @param event - The gateway wire event (typed `unknown` here so this
   *   module doesn't import the WS layer's types)
   */
  private handleBroadcast(channelId: string, event: GatewayWireEvent): void {
    this.pruneExpiredPortals();
    if (this.knownPortals.size === 0) return;
    const payload: ChatEventPayload = { channelId, event };
    // Prefer queueId-direct path for the same reason as `handleRequest`
    // — Portal queueIds may not be in the 30s device-poll cache.
    const send =
      typeof this.cloudSync.sendToPeerQueueId === 'function'
        ? this.cloudSync.sendToPeerQueueId.bind(this.cloudSync)
        : this.cloudSync.sendMessage.bind(this.cloudSync);
    for (const deviceId of this.knownPortals.keys()) {
      // Fire-and-forget — log on failure but keep going.
      send(deviceId, 'chat_event', payload).catch((err) => {
        this.logger.warn('Failed to forward chat_event to Portal', {
          deviceId,
          channelId,
          error: formatError(err),
        });
      });
    }
  }

  /** Evict Portal device entries whose last-seen is older than the TTL. */
  private pruneExpiredPortals(): void {
    const cutoff = this.now() - this.portalIdleTtlMs;
    for (const [deviceId, lastSeen] of this.knownPortals.entries()) {
      if (lastSeen < cutoff) {
        this.knownPortals.delete(deviceId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildPrincipal(): ChatPrincipal {
    // Mirror the dev-anonymous principal used by the REST surface when no
    // JWT secret is configured. In production OSS, this will be the
    // logged-in user's id; for now (single-user OSS) it's the stable
    // dev fallback that owns every chat-v2 channel.
    return { userId: 'dev-user-001', source: 'oss' };
  }

  private requireString(
    params: Record<string, unknown>,
    key: string,
  ): string {
    const v = params[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `${key} is required`,
      );
    }
    return v;
  }

  private optionalString(
    params: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const v = params[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  private optionalNumber(
    params: Record<string, unknown>,
    key: string,
  ): number | undefined {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  private serializeChannel(channel: ChatChannelDTO): ChatChannelDTO {
    // No transformation today, but we keep the indirection so future wire
    // shape divergences (e.g. omitting server-internal fields) live here.
    return channel;
  }

  private serializeMessage(
    message: ChatMessageDTO,
    _fromDevice: string,
  ): ChatMessageDTO {
    return message;
  }

  private errorEnvelope(err: unknown): NonNullable<ChatResponsePayload['error']> {
    if (err instanceof ChatError) {
      return {
        code: err.code,
        message: err.message,
        details: err.details,
      };
    }
    return {
      code: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

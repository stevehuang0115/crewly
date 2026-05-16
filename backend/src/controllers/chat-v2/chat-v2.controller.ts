/**
 * HTTP controller for Phase 1 Chat endpoints.
 *
 * Thin layer: parses + validates requests, delegates to `ChatV2Service`,
 * and maps `ChatError` to HTTP responses. All routes are owner-scoped via
 * `requireAuth` middleware; the principal is lifted from `req.user`.
 *
 * Wiring hooks (all optional — omit for tests that only need REST):
 *   - `gateway.broadcast(channelId, frame)`  — after successful persist,
 *     the controller fans a `message` frame out to WS subscribers so the
 *     sending client's WS re-broadcasts reconcile with its HTTP-201 echo.
 *   - `dispatcher.dispatchToAgent(channel, message)` — fires when a USER
 *     message lands, pushing the text into the bound agent's runtime. The
 *     agent replies via the `reply-channel` skill, which re-enters this
 *     same endpoint with an `X-Crewly-Agent-Session` header.
 *
 * @module controllers/chat-v2/chat-v2.controller
 */

import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/require-auth.middleware.js';
import type { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import type { ChatV2DispatcherService } from '../../services/chat-v2/chat-v2.dispatcher.service.js';
import type { ChatV2Gateway } from '../../websocket/chat-v2.gateway.js';
import { buildMessageEvent } from '../../websocket/chat-v2.gateway.js';
import { getChatV2RealtimeDeps } from '../../services/chat-v2/chat-v2.realtime-holder.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatChannelType,
  type ChatChannelDTO,
  type ChatMessageDTO,
  type ChatPrincipal,
} from '../../services/chat-v2/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the service-level principal from the authenticated request.
 *
 * Honors an optional `X-Crewly-Agent-Session` header — the `reply-channel`
 * skill sets this so the service-layer `resolveSender` returns senderType
 * `agent` instead of `user`. The header is only honored when the request
 * has already passed `requireAuth` (i.e. a trusted bearer), because the
 * service still verifies that `principal.agentSession` matches the
 * channel's bound `agent_session` before marking a message as an agent
 * reply.
 *
 * For Phase 1 the bearer used by the skill is the same OSS session token
 * the owner uses — the agent runs locally on the user's machine. Signed
 * per-agent tokens arrive in Phase 2.
 */
export function principalFromRequest(req: Request): ChatPrincipal {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId) {
    throw new ChatError(CHAT_ERROR_CODES.FORBIDDEN, 401, 'Authentication required');
  }
  // `X-Agent-Session` is the header the shared skills `_common/lib.sh`
  // already attaches to every API call (`CREWLY_SESSION_NAME`). Reusing it
  // means the `reply-channel` skill works with no extra wiring — it just
  // calls `api_call POST /chat/channels/:id/messages ...`.
  const hdr =
    req.headers['x-agent-session'] ?? req.headers['x-crewly-agent-session'];
  const agentSession = typeof hdr === 'string' && hdr.length > 0 ? hdr : undefined;
  return {
    userId: user.userId,
    agentSession,
    source: 'oss',
  };
}

/** Serialize a `ChatError` into the canonical wire shape. */
export function sendChatError(res: Response, err: ChatError): void {
  res.status(err.httpStatus).json({
    success: false,
    error: {
      code: err.code,
      message: err.message,
      details: err.details,
    },
  });
}

/** Fallback 500 responder for unknown failures. */
export function sendInternalError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    success: false,
    error: {
      code: CHAT_ERROR_CODES.INTERNAL,
      message: `Internal error: ${msg}`,
    },
  });
}

/** Thin wrapper that catches ChatError → 4xx and anything else → 500. */
export function runHandler<T>(res: Response, run: () => T): T | undefined {
  try {
    return run();
  } catch (err) {
    if (err instanceof ChatError) {
      sendChatError(res, err);
    } else {
      sendInternalError(res, err);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// INBOUND-2 helpers — V3 Request + SLA hooks for chat-v2 ingress
// ---------------------------------------------------------------------------

/**
 * Build the canonical chat-v2 sourceConversationItemId so the
 * `RequestSlaSubscriber` can dedupe + extract channel/message ids the
 * same way it does for Slack (`slack-${channelId}-${ts}`).
 *
 * Shape: `chatv2-${channelId}__${messageId}`. The inter-field delimiter
 * is the double underscore `__` rather than a single dash because
 * `channel.store.ts:86` and `message.store.ts:165` mint ids via
 * `randomUUID()` (4 dashes embedded in each id). A single-dash
 * delimiter collides with the embedded UUID dashes and corrupts the
 * round-trip — see Arch's review on PR #364 / INBOUND-2.f1.
 * UUIDs are hex digits + dashes only and cannot contain `_`, so `__`
 * is collision-free against any current or future hex-shaped id.
 *
 * @param channelId - Persisted chat-v2 channel id (UUIDv4 in production)
 * @param messageId - Persisted chat-v2 message id (UUIDv4 in production)
 * @returns The composite source id, e.g.
 *   `chatv2-8b3c9a4e-5a02-4d51-9e7a-6f8c4d2e8a1b__fa1e2c3d-4567-89ab-cdef-0123456789ab`
 */
export function buildChatV2SourceId(channelId: string, messageId: string): string {
  return `chatv2-${channelId}__${messageId}`;
}

/**
 * INBOUND-2: decide whether a chat-v2 channel routes user messages to the
 * orchestrator. v1 scope = `type='dm'` channels whose `agentSession`
 * field is the orchestrator session. `type='channel'` (team-scoped) is
 * excluded — the SLA path expects the WI target to be the orchestrator
 * and team-channels haven't yet defined an orc-tagged routing concept
 * (see INBOUND-2 task spec, escalation note "no orc-tagged channels yet").
 *
 * Exported so tests can lock the scope without relying on private state.
 *
 * @param channel - The channel DTO returned by `service.getChannel`.
 * @returns True iff the channel routes to the orchestrator.
 */
export function isOrchestratorRoutedChatV2Channel(channel: ChatChannelDTO): boolean {
  if (channel.type !== 'dm') return false;
  if (!channel.agentSession) return false;
  return channel.agentSession === ORCHESTRATOR_SESSION_NAME;
}

/**
 * Fire-and-forget: if a USER-origin chat-v2 message lands in a channel
 * routed to the orc, register a V3 Request so the
 * `RequestSlaSubscriber` (INBOUND-1) can attach a respond_to_user
 * WorkItem with the 5/10min SLA timers.
 *
 * Mirrors the Slack pattern at
 * `slack-orchestrator-bridge.ts:367-395`. Errors are swallowed and
 * logged at warn-level inside the lazy import — Request creation is
 * non-critical to the chat ack.
 *
 * @param channel - The persisted channel (provides type + agentSession)
 * @param message - The persisted user message (provides id + content)
 */
export function emitChatV2RequestCreated(
  channel: ChatChannelDTO,
  message: ChatMessageDTO,
): void {
  if (message.senderType !== 'user') return;
  if (!isOrchestratorRoutedChatV2Channel(channel)) return;

  setImmediate(async () => {
    try {
      const { RequestService } = await import('../../services/v3/request.service.js');
      const svc = RequestService.getInstance();
      const sourceId = buildChatV2SourceId(channel.id, message.id);
      const existing = await svc.findBySourceConversationItemId(sourceId);
      if (existing) return;

      const { generateRequestTitle, classifyIntent } = await import('../../services/v3/v3-data.service.js');
      const rawText = message.content || '';
      const { intentLevel, intentCategory } = classifyIntent(rawText);
      await svc.create({
        title: generateRequestTitle(rawText, intentCategory),
        description: rawText,
        sourceConversationItemId: sourceId,
        priority: 'normal',
        tags: ['chat-v2'],
        intentLevel,
        intentCategory,
      });
    } catch {
      // Non-critical — Request creation failure must not break chat send.
    }
  });
}

/**
 * Fire-and-forget: when an AGENT-origin chat-v2 message lands in a
 * channel that may have an outstanding `respond_to_user` WI tracked by
 * the SLA subscriber, mark it resolved (transitions the WI to `done`,
 * silences the breach + escalation timers).
 *
 * Safe to call for any agent-origin message — `markResolvedByChatV2` is
 * a no-op when the channel isn't tracked.
 *
 * @param message - The persisted message (only agent-origin is acted on)
 */
export function notifyChatV2AgentReply(message: ChatMessageDTO): void {
  if (message.senderType !== 'agent') return;

  setImmediate(async () => {
    try {
      const { getRequestSlaSubscriber } = await import(
        '../../services/v3/request-sla.subscriber.js'
      );
      const sub = getRequestSlaSubscriber();
      if (!sub) return;
      await sub.markResolvedByChatV2(message.channelId);
    } catch {
      // Non-critical — auto-resolve failure must not break chat send.
    }
  });
}

// ---------------------------------------------------------------------------
// Controller factory
// ---------------------------------------------------------------------------

/** Express handlers returned by `createChatV2Controller`. */
export interface ChatV2ControllerHandlers {
  listChannels: (req: Request, res: Response) => void;
  createChannel: (req: Request, res: Response) => void;
  getChannel: (req: Request, res: Response) => void;
  archiveChannel: (req: Request, res: Response) => void;
  listMessages: (req: Request, res: Response) => void;
  sendMessage: (req: Request, res: Response) => void | Promise<void>;
  ensureDmChannel: (req: Request, res: Response) => void;
  listAgents: (req: Request, res: Response) => void | Promise<void>;
  getAgentPresence: (req: Request, res: Response) => void | Promise<void>;
}

/**
 * Minimal directory entry surfaced by `GET /api/chat/agents`.
 *
 * Lives on the wire as-is; the /agents page renders one row per entry,
 * grouped by team. The fields match the join the controller performs
 * between {@link IAgentDirectoryProvider} (teams + members) and the
 * presence provider, with no extra denormalization.
 */
export interface ChatAgentDirectoryEntry {
  /** Member's `sessionName` — the agent's wire id, matches `Channel.agentSession`. */
  agentSession: string;
  /** Member display name (e.g. "Leo"). */
  name: string;
  /** Member role (e.g. "team-leader"). */
  role: string;
  /** Owning team id. */
  teamId: string;
  /** Owning team display name. */
  teamName: string;
  /** Stored agentStatus from the team file. */
  agentStatus: string;
  /** Stored workingStatus from the team file. */
  workingStatus: string;
  /** Optional emoji / avatar surfaced by the team file. */
  avatar?: string;
}

/**
 * Minimal storage surface the controller needs to enumerate agents.
 * Decoupled from `StorageService` so tests can pass a fixture without
 * spinning up SQLite + the team-file watcher.
 */
export interface IAgentDirectoryProvider {
  /**
   * Return all teams + members visible to the caller. The controller
   * filters/flattens; no need to pre-shape the response.
   */
  getTeams(): Promise<
    Array<{
      id: string;
      name: string;
      members: Array<{
        sessionName: string;
        name: string;
        role: string;
        agentStatus: string;
        workingStatus: string;
        avatar?: string;
      }>;
    }>
  >;
}

/** Wire shape returned by `GET /api/chat/presence/:agentId`. */
export interface ChatAgentPresenceDTO {
  agentSession: string;
  status: 'online' | 'busy' | 'offline' | 'starting';
  lastSeenAt: number | null;
}

/**
 * Presence resolver. Returns the live status + last-seen timestamp for
 * an agent session. Default implementation (`createDefaultPresenceProvider`)
 * delegates to the orchestrator-status helper; tests inject a stub.
 */
export interface IAgentPresenceProvider {
  getPresence(agentSession: string): Promise<ChatAgentPresenceDTO>;
}

/**
 * Optional wiring for real-time fan-out + agent dispatch. Leave undefined
 * in REST-only tests; supply both in the live server.
 *
 * Phase F — `directory` + `presence` providers are needed only by the
 * new `/agents`, `/presence/:id`, and `/channels/dm/ensure` endpoints.
 * When omitted, those endpoints return HTTP 503 `directory_unavailable`
 * so REST-only tests can keep mounting the router without wiring storage.
 */
export interface ChatV2ControllerDeps {
  gateway?: ChatV2Gateway;
  dispatcher?: ChatV2DispatcherService;
  directory?: IAgentDirectoryProvider;
  presence?: IAgentPresenceProvider;
}

/**
 * Build Express-compatible handlers for the chat-v2 endpoints.
 *
 * @param service - A configured ChatV2Service
 * @param deps    - Optional gateway/dispatcher for realtime wiring
 * @returns One handler per endpoint; wire into an Express Router
 */
export function createChatV2Controller(
  service: ChatV2Service,
  deps: ChatV2ControllerDeps = {},
): ChatV2ControllerHandlers {
  // Deps resolve in this order:
  //   1. explicit argument (tests + the realtime-aware router)
  //   2. process-wide realtime holder (populated by server start-up)
  // Falling back to the holder means the router can be mounted before the
  // gateway is live, and picks up realtime deps once they register.
  const resolveDeps = (): ChatV2ControllerDeps => {
    if (deps.gateway || deps.dispatcher) return deps;
    const live = getChatV2RealtimeDeps();
    return {
      gateway: live.gateway ?? deps.gateway,
      dispatcher: live.dispatcher ?? deps.dispatcher,
      // `directory` + `presence` are constructor-only (not realtime); pass
      // them through unchanged so the holder fallback path still surfaces
      // them to the agents/presence handlers.
      directory: deps.directory,
      presence: deps.presence,
    };
  };

  return {
    listChannels: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const includeArchived = req.query.includeArchived === 'true';
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
        // Phase C — channel-rail listing refinements.
        // `type` and `teamId` query params let the rail fetch a focused
        // slice (e.g. only DMs, or only channels in the active workspace)
        // without shipping the full owner-scoped list. Both are optional
        // and compose with AND. Service-layer rejects unknown `type`
        // values with `validation_error`; we forward as-is so the caller
        // gets a precise error message.
        const typeRaw = req.query.type;
        const type = typeof typeRaw === 'string' && typeRaw.length > 0 ? typeRaw : undefined;
        const teamIdRaw = req.query.teamId;
        const teamId =
          typeof teamIdRaw === 'string' && teamIdRaw.length > 0 ? teamIdRaw : undefined;
        const channels = service.listChannels({
          principal,
          includeArchived,
          limit: Number.isFinite(limit) ? limit : undefined,
          type: type as ChatChannelType | undefined,
          teamId,
        });
        res.json({ success: true, data: { channels, nextCursor: null } });
      }),

    createChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const channel = service.createChannel({
          agentSession: body.agentSession,
          name: body.name,
          purpose: body.purpose,
          principal,
          // Phase A (SEALED §3.1) — Slack-like channel surfaces. Service
          // layer validates the type↔teamId↔targetMemberId combinations.
          type: body.type,
          teamId: body.teamId,
          projectId: body.projectId,
          targetMemberId: body.targetMemberId,
        });
        res.status(201).json({ success: true, data: channel });
      }),

    getChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const channel = service.getChannel(req.params.id, principal);
        res.json({ success: true, data: channel });
      }),

    archiveChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        service.archiveChannel(req.params.id, principal);
        res.status(204).end();
      }),

    listMessages: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
        const directionRaw = req.query.direction;
        const direction: 'backward' | 'forward' =
          directionRaw === 'forward' ? 'forward' : 'backward';
        const result = service.listMessages({
          channelId: req.params.id,
          principal,
          cursor,
          limit: Number.isFinite(limit) ? limit : undefined,
          direction,
        });
        res.json({ success: true, data: result });
      }),

    /**
     * POST /channels/:id/messages
     *
     * Order of operations:
     *  1. Persist via `ChatV2Service.sendMessage` (resolves senderType from
     *     `principal.agentSession` — set by the `X-Crewly-Agent-Session`
     *     header when the agent's `reply-channel` skill is the caller).
     *  2. Send HTTP 201 with the DTO (the contract-locked ack — clients
     *     reconcile optimistic pending bubbles by `clientMessageId`).
     *  3. Broadcast a WS `message` frame so peer subscribers of the same
     *     channel see the row. Idempotent on the client — reconciliation
     *     dedupes by `clientMessageId` first, then by `id`.
     *  4. If the message is USER-origin, kick the dispatcher to push the
     *     text into the agent session. Agent-origin messages skip this
     *     step to avoid self-loopback.
     *
     * Steps 3 + 4 are fire-and-forget: they run after `res.status(201)` so
     * a broken WS / missing agent never blocks the HTTP ack.
     */
    sendMessage: async (req, res) => {
      // Persist + 201 — on error, runHandler serializes it and we bail
      // without running any post-ack side-effects. On success, the
      // closure populates `persisted` + `channelForDispatch`.
      let persisted: ChatMessageDTO | undefined;
      let channelForDispatch: Awaited<ReturnType<typeof service.getChannel>> | null = null;

      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        if (Array.isArray(body.attachments) && body.attachments.length > 0) {
          throw new ChatError(
            CHAT_ERROR_CODES.VALIDATION,
            400,
            'attachments are not yet supported on this endpoint',
          );
        }
        const message = service.sendMessage({
          channelId: req.params.id,
          principal,
          content: body.content,
          contentType: body.contentType,
          clientMessageId: body.clientMessageId,
          attachments: [],
          // Phase A (SEALED §3.2) — mentions + threadId are forwarded to
          // the service which validates and persists them.
          mentions: body.mentions,
          threadId: body.threadId,
        });
        res.status(201).json({ success: true, data: message });
        persisted = message;
        // Look up channel for gateway + dispatcher wiring. `getChannel`
        // requires `principal.userId === channel.owner_user_id` — which
        // matches both the normal user case and the agent-reply case
        // (the agent's principal inherits the owner's userId in Phase 1).
        try {
          channelForDispatch = service.getChannel(message.channelId, {
            userId: principal.userId,
            source: principal.source,
          });
        } catch {
          channelForDispatch = null;
        }
      });

      // If `persisted` is still undefined, runHandler already serialized an
      // error response — skip the realtime fan-out.
      if (!persisted) return;

      // -------- post-ack realtime side-effects --------
      const { gateway, dispatcher } = resolveDeps();
      try {
        if (gateway && channelForDispatch) {
          gateway.broadcast(
            persisted.channelId,
            buildMessageEvent(persisted.channelId, persisted),
          );
        }
      } catch {
        // broadcast must never break the ack
      }

      try {
        if (dispatcher && channelForDispatch && persisted.senderType === 'user') {
          // Phase C BE.3 — single high-level entry point that branches
          // on `channel.type` internally:
          //   `type='dm'`     → 1:1 dispatch via dispatchToAgent (legacy)
          //   `type='channel'`→ resolve `mentions[]` → fan-out per target
          // Fire-and-forget — already past the HTTP ack at this point.
          void dispatcher.dispatchMessage(channelForDispatch, persisted);
        }
      } catch {
        // dispatcher must never break the ack
      }

      // INBOUND-2 — V3 Request + SLA-tracking hooks. Mirrors the Slack
      // ingress pattern at slack-orchestrator-bridge.ts:367-395.
      // Fire-and-forget; failures are isolated inside the helpers.
      try {
        if (channelForDispatch) {
          emitChatV2RequestCreated(channelForDispatch, persisted);
        }
        notifyChatV2AgentReply(persisted);
      } catch {
        // INBOUND-2 hooks must never break the ack
      }
    },

    /**
     * POST /channels/dm/ensure
     *
     * Find-or-create a DM channel for the caller bound to `agentSession`.
     * Idempotent: repeated calls for the same (owner, agentSession) return
     * the same channel row, so the /agents page can map "click agent" →
     * "active channel" without leaking duplicate DMs on reloads.
     *
     * Status code:
     *  - 200 when the channel already existed
     *  - 201 when a new channel was created
     */
    ensureDmChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const { channel, created } = service.ensureDmChannel({
          agentSession: body.agentSession,
          name: body.name,
          purpose: body.purpose,
          principal,
        });
        res.status(created ? 201 : 200).json({ success: true, data: channel });
      }),

    /**
     * GET /agents
     *
     * Directory of all agents reachable from the configured teams.
     * Returns one entry per (team × member), with cached
     * agentStatus/workingStatus from the team file. The /agents page
     * uses this to render the left rail; presence freshness comes from
     * the per-agent `GET /presence/:agentId` endpoint, not from this list
     * (intentional — the list is cheap; presence is per-row + on focus).
     *
     * Returns HTTP 503 `directory_unavailable` when the controller was
     * wired without a `directory` provider (REST-only tests, etc.).
     */
    listAgents: async (req, res) => {
      try {
        // principalFromRequest enforces auth; the returned principal is
        // intentionally unused here because the directory is global
        // within a single OSS instance (no per-user filtering yet).
        principalFromRequest(req);
        const { directory } = resolveDeps();
        if (!directory) {
          res.status(503).json({
            success: false,
            error: {
              code: 'directory_unavailable',
              message: 'agent directory provider is not wired',
            },
          });
          return;
        }
        const teams = await directory.getTeams();
        const entries: ChatAgentDirectoryEntry[] = [];
        for (const team of teams) {
          for (const member of team.members) {
            const sessionName = (member.sessionName ?? '').trim();
            if (sessionName.length === 0) continue;
            entries.push({
              agentSession: sessionName,
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
        res.json({ success: true, data: { agents: entries } });
      } catch (err) {
        if (err instanceof ChatError) {
          sendChatError(res, err);
        } else {
          sendInternalError(res, err);
        }
      }
    },

    /**
     * GET /presence/:agentId
     *
     * Returns the agent's current presence + last-seen timestamp. Backs
     * the chat-ui `getAgentPresence(agentId)` client call so the message
     * thread can surface a live `online/busy/offline` badge per agent.
     *
     * Returns HTTP 503 `presence_unavailable` when the controller was
     * wired without a `presence` provider (REST-only tests).
     */
    getAgentPresence: async (req, res) => {
      try {
        principalFromRequest(req);
        const agentId = (req.params.agentId ?? '').trim();
        if (agentId.length === 0) {
          throw new ChatError(
            CHAT_ERROR_CODES.VALIDATION,
            400,
            'agentId is required',
          );
        }
        const { presence } = resolveDeps();
        if (!presence) {
          res.status(503).json({
            success: false,
            error: {
              code: 'presence_unavailable',
              message: 'presence provider is not wired',
            },
          });
          return;
        }
        const result = await presence.getPresence(agentId);
        res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof ChatError) {
          sendChatError(res, err);
        } else {
          sendInternalError(res, err);
        }
      }
    },
  };
}

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
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatChannelType,
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
}

/**
 * Optional wiring for real-time fan-out + agent dispatch. Leave undefined
 * in REST-only tests; supply both in the live server.
 */
export interface ChatV2ControllerDeps {
  gateway?: ChatV2Gateway;
  dispatcher?: ChatV2DispatcherService;
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
          void dispatcher.dispatchToAgent(channelForDispatch, persisted);
        }
      } catch {
        // dispatcher must never break the ack
      }
    },
  };
}

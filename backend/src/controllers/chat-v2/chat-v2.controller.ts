/**
 * HTTP controller for Phase 1 Chat endpoints.
 *
 * Thin layer: parses + validates requests, delegates to `ChatV2Service`,
 * and maps `ChatError` to HTTP responses. All routes are owner-scoped via
 * `requireAuth` middleware; the principal is lifted from `req.user`.
 *
 * @module controllers/chat-v2/chat-v2.controller
 */

import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/require-auth.middleware.js';
import type { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatPrincipal,
} from '../../services/chat-v2/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map an auth-middleware `req.user` object into the service-level principal. */
export function principalFromRequest(req: Request): ChatPrincipal {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId) {
    // requireAuth guarantees this in production, but defensive coding is cheap.
    throw new ChatError(CHAT_ERROR_CODES.FORBIDDEN, 401, 'Authentication required');
  }
  return {
    userId: user.userId,
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
  sendMessage: (req: Request, res: Response) => void;
}

/**
 * Build Express-compatible handlers for the chat-v2 endpoints.
 *
 * @param service - A configured ChatV2Service
 * @returns One handler per endpoint; wire into an Express Router
 */
export function createChatV2Controller(service: ChatV2Service): ChatV2ControllerHandlers {
  return {
    listChannels: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const includeArchived = req.query.includeArchived === 'true';
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
        const channels = service.listChannels({
          principal,
          includeArchived,
          limit: Number.isFinite(limit) ? limit : undefined,
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

    sendMessage: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const message = service.sendMessage({
          channelId: req.params.id,
          principal,
          content: body.content,
          contentType: body.contentType,
          clientMessageId: body.clientMessageId,
          // Attachments not supported until the upload endpoint lands — reject up-front
          // for clarity, rather than silently dropping them.
          attachments: (() => {
            if (Array.isArray(body.attachments) && body.attachments.length > 0) {
              throw new ChatError(
                CHAT_ERROR_CODES.VALIDATION,
                400,
                'attachments are not yet supported on this endpoint',
              );
            }
            return [];
          })(),
        });
        res.status(201).json({ success: true, data: message });
      }),
  };
}

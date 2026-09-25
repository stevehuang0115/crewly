/**
 * WhatsApp Inbox Controller
 *
 * Read API and reply drafts for the WhatsApp inbox connector, mounted under
 * `/api/whatsapp`:
 *
 * | Method | Path                        | Who            |
 * |--------|-----------------------------|----------------|
 * | GET    | /inbox?limit=&includeGroups=| owner, agents  |
 * | GET    | /chats?limit=&q=            | owner, agents  |
 * | GET    | /chats/:chatId/messages     | owner, agents  |
 * | GET    | /search?q=&limit=           | owner, agents  |
 * | POST   | /drafts {chatId, text}      | owner, agents  |
 * | GET    | /drafts?status=&limit=      | owner, agents  |
 * | POST   | /drafts/:id/discard         | owner, agents  |
 * | POST   | /drafts/:id/send            | owner; agents only with the owner's 「发 <code>」 |
 *
 * Every response is `{ success, data }` or `{ success: false, error, code }`.
 * The send gate is in `services/whatsapp/whatsapp-draft-gate.ts`.
 *
 * @module controllers/whatsapp/whatsapp-inbox
 */

import { Router, Request, Response, NextFunction } from 'express';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { getWhatsAppInboxStore, type WhatsAppInboxStore } from '../../services/whatsapp/whatsapp-inbox.store.js';
import { getWhatsAppService } from '../../services/whatsapp/whatsapp.service.js';
import {
  buildOwnerConfirmPrompt,
  buildRefusalMessage,
  decideDraftSend,
} from '../../services/whatsapp/whatsapp-draft-gate.js';
import { getChatV2Service } from '../../services/chat-v2/chat-v2.singleton.js';
import type { WhatsAppDraft, WhatsAppDraftStatus, WhatsAppOutgoingMessage } from '../../types/whatsapp.types.js';

const logger = LoggerService.getInstance().createComponentLogger('WhatsAppInbox');

/** The slice of WhatsAppService the inbox routes use. */
export interface WhatsAppInboxSender {
  /** Whether the socket is connected */
  isConnected(): boolean;
  /** Send one text message */
  sendMessage(msg: WhatsAppOutgoingMessage): Promise<void>;
}

/** Injectable dependencies (tests pass fakes). */
export interface WhatsAppInboxDeps {
  /** Inbox store */
  getStore: () => WhatsAppInboxStore;
  /** Socket sender */
  getSender: () => WhatsAppInboxSender;
  /** Genuine owner chat messages created at/after `sinceMs`, newest first */
  getOwnerMessagesSince: (sinceMs: number, limit: number) => string[];
  /** Clock */
  now: () => number;
}

/** Production dependencies. */
const DEFAULT_DEPS: WhatsAppInboxDeps = {
  getStore: getWhatsAppInboxStore,
  getSender: getWhatsAppService,
  getOwnerMessagesSince: (sinceMs, limit) => getChatV2Service().getRecentOwnerMessageContents(sinceMs, limit),
  now: () => Date.now(),
};

/**
 * Parse a `limit` query value, clamped to `[1, max]`.
 *
 * @param raw - Query value
 * @param def - Default when absent/invalid
 * @param max - Hard cap
 * @returns The limit
 */
export function parseLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/**
 * Parse a boolean query flag (`true`/`1`/`yes`).
 *
 * @param raw - Query value
 * @returns True only for an explicit truthy value
 */
export function parseFlag(raw: unknown): boolean {
  return typeof raw === 'string' && ['true', '1', 'yes'].includes(raw.toLowerCase());
}

/**
 * Send a JSON error with a machine-readable code.
 *
 * @param res - Response
 * @param status - HTTP status
 * @param code - Error code (`WHATSAPP_CONSTANTS.ERROR_CODES`)
 * @param error - Human message
 * @param data - Optional extra payload
 */
function fail(res: Response, status: number, code: string, error: string, data?: Record<string, unknown>): void {
  res.status(status).json({ success: false, code, error, ...(data ? { data } : {}) });
}

/**
 * Whether a string is a valid draft status filter.
 *
 * @param v - Query value
 * @returns True for pending/sending/sent/discarded
 */
function isDraftStatus(v: unknown): v is WhatsAppDraftStatus {
  return Object.values(WHATSAPP_CONSTANTS.DRAFT_STATUSES).includes(v as WhatsAppDraftStatus);
}

/**
 * Create the inbox router.
 *
 * @param overrides - Dependency overrides (tests)
 * @returns Router to mount under `/api/whatsapp`
 */
export function createWhatsAppInboxRouter(overrides: Partial<WhatsAppInboxDeps> = {}): Router {
  const deps: WhatsAppInboxDeps = { ...DEFAULT_DEPS, ...overrides };
  const router = Router();
  const L = WHATSAPP_CONSTANTS.LIMITS;
  const E = WHATSAPP_CONSTANTS.ERROR_CODES;
  /** Serializes sends so drafts go out one at a time. */
  let sendChain: Promise<unknown> = Promise.resolve();

  /**
   * Label a draft's recipient for humans.
   *
   * @param store - Store
   * @param draft - Draft
   * @returns Draft plus `recipient` (chat name or JID)
   */
  const withRecipient = (store: WhatsAppInboxStore, draft: WhatsAppDraft) => ({
    ...draft,
    recipient: store.getChat(draft.chatId)?.name ?? draft.chatId,
  });

  /** GET /inbox — chats whose newest message is not the owner's. */
  router.get('/inbox', (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = deps.getStore().listInbox({
        limit: parseLimit(req.query.limit, L.INBOX_DEFAULT, L.INBOX_MAX),
        includeGroups: parseFlag(req.query.includeGroups),
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  /** GET /chats — recent chats, optional name/JID filter. */
  router.get('/chats', (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const data = deps.getStore().listChats({ limit: parseLimit(req.query.limit, L.CHATS_DEFAULT, L.CHATS_MAX), q });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  /** GET /chats/:chatId/messages — one page, oldest first; `before` = epoch ms (exclusive). */
  router.get('/chats/:chatId/messages', (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = deps.getStore();
      const chat = store.getChat(req.params.chatId);
      if (!chat) {
        fail(res, 404, E.CHAT_NOT_FOUND, `Unknown chat: ${req.params.chatId}`);
        return;
      }
      const beforeRaw = typeof req.query.before === 'string' ? Number(req.query.before) : undefined;
      const before = beforeRaw !== undefined && Number.isFinite(beforeRaw) ? beforeRaw : undefined;
      const limit = parseLimit(req.query.limit, L.MESSAGES_DEFAULT, L.MESSAGES_MAX);
      const messages = store.listMessages(chat.id, { limit, before });
      const nextBefore = messages.length === limit && messages.length > 0 ? messages[0].ts : null;
      res.json({ success: true, data: { chat, messages, nextBefore } });
    } catch (error) {
      next(error);
    }
  });

  /** GET /search — substring search over message text. */
  router.get('/search', (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q) {
        fail(res, 400, E.INVALID_INPUT, 'q is required');
        return;
      }
      const data = deps.getStore().search(q, parseLimit(req.query.limit, L.SEARCH_DEFAULT, L.SEARCH_MAX));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  /** POST /drafts — propose a reply. Never sends. */
  router.post('/drafts', (req: Request, res: Response, next: NextFunction) => {
    try {
      const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!chatId || !text) {
        fail(res, 400, E.INVALID_INPUT, 'chatId and text are required');
        return;
      }
      if (text.length > WHATSAPP_CONSTANTS.MAX_MESSAGE_LENGTH) {
        fail(res, 400, E.INVALID_INPUT, `Message exceeds maximum length of ${WHATSAPP_CONSTANTS.MAX_MESSAGE_LENGTH} characters`);
        return;
      }
      const store = deps.getStore();
      const chat = store.getChat(chatId);
      if (!chat) {
        fail(res, 404, E.CHAT_NOT_FOUND, `Unknown chat: ${chatId}. Draft replies only to chats in the inbox.`);
        return;
      }
      const createdBy = readAgentSessionHeader(req) ?? null;
      const draft = store.createDraft({ chatId, text, createdBy, now: deps.now() });
      const recipient = chat.name ?? chat.id;
      logger.info('Draft created', { code: draft.code, chatId, createdBy });
      res.status(201).json({
        success: true,
        data: { ...draft, recipient, instruction: buildOwnerConfirmPrompt(draft, recipient) },
      });
    } catch (error) {
      next(error);
    }
  });

  /** GET /drafts — newest first, optional status filter. */
  router.get('/drafts', (req: Request, res: Response, next: NextFunction) => {
    try {
      const statusRaw = req.query.status;
      if (statusRaw !== undefined && !isDraftStatus(statusRaw)) {
        fail(res, 400, E.INVALID_INPUT, `Invalid status: ${String(statusRaw)}`);
        return;
      }
      const store = deps.getStore();
      const drafts = store.listDrafts({
        status: statusRaw as WhatsAppDraftStatus | undefined,
        limit: parseLimit(req.query.limit, L.DRAFTS_DEFAULT, L.DRAFTS_MAX),
      });
      res.json({ success: true, data: drafts.map((d) => withRecipient(store, d)) });
    } catch (error) {
      next(error);
    }
  });

  /** POST /drafts/:id/discard — drop a pending draft (id or code). */
  router.post('/drafts/:id/discard', (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = deps.getStore();
      const draft = store.findDraft(req.params.id);
      if (!draft) {
        fail(res, 404, E.DRAFT_NOT_FOUND, `No draft ${req.params.id}`);
        return;
      }
      if (!store.discardDraft(draft.id, deps.now())) {
        fail(res, 409, E.DRAFT_NOT_PENDING, `Draft ${draft.code} is ${draft.status}, not pending`, { status: draft.status });
        return;
      }
      logger.info('Draft discarded', { code: draft.code, by: readAgentSessionHeader(req) ?? 'owner' });
      res.json({ success: true, data: withRecipient(store, store.getDraftById(draft.id) as WhatsAppDraft) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /drafts/:id/send — send one draft, gated on the owner.
   * Owner (no X-Agent-Session): allowed. Agent: only with the owner's
   * 「发 <code>」 in chat after the draft, within the confirm window.
   */
  router.post('/drafts/:id/send', (req: Request, res: Response, next: NextFunction) => {
    const run = async (): Promise<void> => {
      const store = deps.getStore();
      const draft = store.findDraft(req.params.id);
      if (!draft) {
        fail(res, 404, E.DRAFT_NOT_FOUND, `No draft ${req.params.id}`);
        return;
      }
      if (draft.status !== WHATSAPP_CONSTANTS.DRAFT_STATUSES.PENDING) {
        fail(res, 409, E.DRAFT_NOT_PENDING, `Draft ${draft.code} is ${draft.status}; it cannot be sent`, { status: draft.status });
        return;
      }
      const agentSession = readAgentSessionHeader(req);
      const decision = decideDraftSend({
        draft,
        agentSession,
        ownerMessagesSince: (since) => deps.getOwnerMessagesSince(since, WHATSAPP_CONSTANTS.OWNER_CONFIRM_SCAN_LIMIT),
        now: deps.now(),
      });
      if (!decision.allowed) {
        logger.warn('Agent draft send refused', { code: draft.code, agentSession, reason: decision.reason });
        fail(res, 403, E.NEEDS_OWNER_CONFIRMATION, buildRefusalMessage(draft, decision.reason), {
          code: draft.code,
          reason: decision.reason,
        });
        return;
      }
      const sender = deps.getSender();
      if (!sender.isConnected()) {
        fail(res, 503, E.NOT_CONNECTED, 'WhatsApp is not connected');
        return;
      }
      if (!store.claimDraftForSend(draft.id)) {
        fail(res, 409, E.DRAFT_NOT_PENDING, `Draft ${draft.code} is already being sent or was sent`);
        return;
      }
      try {
        await sender.sendMessage({ to: draft.chatId, text: draft.text });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        store.releaseDraftClaim(draft.id, msg);
        logger.error('Draft send failed', { code: draft.code, error: msg });
        fail(res, 502, E.SEND_FAILED, `Send failed: ${msg}`);
        return;
      }
      store.markDraftSent(draft.id, deps.now());
      logger.info('Draft sent', { code: draft.code, chatId: draft.chatId, via: decision.via, agentSession });
      res.json({
        success: true,
        data: { ...withRecipient(store, store.getDraftById(draft.id) as WhatsAppDraft), via: decision.via },
      });
    };
    const p = sendChain.then(run, run);
    sendChain = p.catch(() => undefined);
    p.catch(next);
  });

  return router;
}

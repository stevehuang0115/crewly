/**
 * Owner decisions API (specs/2026-10-01-decision-cards.md) and the Slack
 * interactivity endpoint.
 *
 * - POST /api/decisions               — ask the owner (agents: X-Agent-Session)
 * - GET  /api/decisions?status=open   — open + parked (default) or `all`
 * - GET  /api/decisions/:id
 * - POST /api/decisions/:id/choose    — `{ option }` (owner only: no agent header)
 * - POST /api/decisions/:id/remind    — "Remind me tomorrow" (owner only)
 * - POST /api/decisions/:id/cancel    — withdraw (the asker, the requester, the orchestrator or the owner)
 * - POST /api/slack/interactivity     — a Cloud-forwarded envelope or Slack's signed `payload=` form
 *
 * @module controllers/decisions/decisions.controller
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { DecisionError, DecisionService, type BlockActionsPayload } from '../../services/decisions/decision.service.js';

/** Slack rejects requests older than this (s). */
const SLACK_SIGNATURE_MAX_AGE_S = 5 * 60;

/** Collaborators (tests). */
export interface DecisionsControllerDeps {
  service: () => DecisionService | null;
  /** Hand a verified interactive payload to Slack listeners */
  emitInteraction: (payload: unknown, source: 'http' | 'cloud', eventId?: string) => void;
  /** The Slack signing secret, when one is configured */
  signingSecret: () => string | undefined;
  now?: () => number;
}

/**
 * Run a handler and map errors.
 *
 * @param res - Response
 * @param status - Success status
 * @param body - Handler
 */
async function respond(res: Response, status: number, body: () => Promise<unknown>): Promise<void> {
  try {
    res.status(status).json({ success: true, data: await body() });
  } catch (err) {
    if (err instanceof DecisionError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Verify a Slack request signature (`v0=` HMAC-SHA256 of `v0:<ts>:<body>`).
 *
 * @param secret - Signing secret
 * @param timestamp - `X-Slack-Request-Timestamp`
 * @param signature - `X-Slack-Signature`
 * @param rawBody - Exact request body
 * @param nowS - Clock (s)
 * @returns True when valid and fresh
 */
export function verifySlackSignature(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, nowS: number): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_S) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Require a running service.
 *
 * @param deps - Deps
 * @returns Service
 * @throws DecisionError(503)
 */
function svc(deps: DecisionsControllerDeps): DecisionService {
  const s = deps.service();
  if (!s) throw new DecisionError(503, 'Decision cards are not ready yet — Crewly is still starting');
  return s;
}

/**
 * Refuse agents: only the owner (dashboard, phone) answers.
 *
 * @param req - Request
 * @throws DecisionError(403)
 */
function requireOwner(req: Request): void {
  if (readAgentSessionHeader(req)) throw new DecisionError(403, 'Only the owner answers decisions. Agents ask with ask-owner and wait for the [DECISION] message.');
}

/**
 * The `/api/decisions` router.
 *
 * @param deps - Collaborators
 * @returns Router
 */
export function createDecisionsRouter(deps: DecisionsControllerDeps): Router {
  const router = Router();
  router.post('/', (req, res) =>
    respond(res, 201, () => svc(deps).ask(readAgentSessionHeader(req) ?? undefined, (req.body ?? {}) as Record<string, unknown>)),
  );
  router.get('/', (req, res) =>
    respond(res, 200, () => svc(deps).list(String(req.query.status ?? 'open') === 'all' ? 'all' : 'open')),
  );
  router.get('/:id', (req, res) =>
    respond(res, 200, async () => {
      const d = await svc(deps).get(req.params.id);
      if (!d) throw new DecisionError(404, `Decision ${req.params.id} not found`);
      return d;
    }),
  );
  router.post('/:id/choose', (req, res) =>
    respond(res, 200, async () => {
      requireOwner(req);
      const option = (req.body ?? {}).option;
      if (typeof option !== 'string' || !option.trim()) throw new DecisionError(400, 'option is required');
      return svc(deps).chooseFromDashboard(req.params.id, option.trim());
    }),
  );
  router.post('/:id/remind', (req, res) =>
    respond(res, 200, async () => {
      requireOwner(req);
      return svc(deps).remindFromDashboard(req.params.id);
    }),
  );
  router.post('/:id/cancel', (req, res) =>
    respond(res, 200, async () => {
      const s = svc(deps);
      const d = await s.get(req.params.id);
      if (!d) throw new DecisionError(404, `Decision ${req.params.id} not found`);
      const caller = readAgentSessionHeader(req);
      if (caller && caller !== d.asker && caller !== d.requestedBy && caller !== ORCHESTRATOR_SESSION_NAME) {
        throw new DecisionError(403, `Only ${d.asker} (who asked) can withdraw ${d.id}`);
      }
      await s.cancelWhere((x) => x.id === d.id, typeof req.body?.note === 'string' ? req.body.note : undefined);
      return s.get(d.id);
    }),
  );
  return router;
}

/**
 * POST /api/slack/interactivity. Accepts:
 * - a Cloud `slack_event` envelope (`{ event: { type: 'block_actions' }, interaction }`) —
 *   only from loopback (the relay normally delivers these in-process);
 * - Slack's own `payload=<json>` form — only with a valid Slack signature.
 * Answers 200 at once (Slack allows 3 s); the card is updated with `chat.update`.
 *
 * @param deps - Collaborators
 * @returns Express handler
 */
export function createSlackInteractivityHandler(deps: DecisionsControllerDeps) {
  return function slackInteractivity(req: Request, res: Response): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.payload === 'string') {
      const raw = (req as Request & { rawBody?: string }).rawBody ?? '';
      const secret = deps.signingSecret();
      const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      if (!secret || !verifySlackSignature(secret, req.header('x-slack-request-timestamp'), req.header('x-slack-signature'), raw, nowS)) {
        res.status(401).json({ success: false, error: 'invalid_signature' });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.payload);
      } catch {
        res.status(400).json({ success: false, error: 'invalid_payload' });
        return;
      }
      if (!payload || typeof payload !== 'object') {
        res.status(400).json({ success: false, error: 'invalid_payload' });
        return;
      }
      if ((payload as BlockActionsPayload).type === 'block_actions') deps.emitInteraction(payload, 'http');
      res.status(200).end();
      return;
    }
    const event = body.event as { type?: string } | undefined;
    if (event?.type === 'block_actions' && body.interaction && typeof body.interaction === 'object') {
      if (!isLoopback(req)) {
        res.status(401).json({ success: false, error: 'forwarded payloads are accepted from this machine only' });
        return;
      }
      deps.emitInteraction(body.interaction, 'cloud', typeof body.eventId === 'string' ? body.eventId : undefined);
      res.status(200).end();
      return;
    }
    res.status(400).json({ success: false, error: 'invalid_payload' });
  };
}

/**
 * Whether the request came from this machine.
 *
 * @param req - Request
 * @returns True for loopback addresses
 */
function isLoopback(req: Request): boolean {
  const ip = req.socket?.remoteAddress ?? req.ip ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * The real collaborators.
 *
 * @returns Deps
 */
export async function defaultDecisionsControllerDeps(): Promise<DecisionsControllerDeps> {
  const { getSlackService } = await import('../../services/slack/slack.service.js');
  return {
    service: () => DecisionService.getInstance(),
    emitInteraction: (payload, source, eventId) => getSlackService().emitInteraction({ payload, source, ...(eventId ? { eventId } : {}) }),
    signingSecret: () => getSlackService().getConfig()?.signingSecret || process.env.SLACK_SIGNING_SECRET || undefined,
  };
}

/**
 * Lazily resolved default deps (the Slack module is heavy; load it on first use).
 *
 * @returns Deps that resolve the real collaborators per call
 */
export function lazyDecisionsControllerDeps(): DecisionsControllerDeps {
  let real: DecisionsControllerDeps | null = null;
  void defaultDecisionsControllerDeps().then((d) => {
    real = d;
  });
  return {
    service: () => DecisionService.getInstance(),
    emitInteraction: (payload, source, eventId) => real?.emitInteraction(payload, source, eventId),
    signingSecret: () => real?.signingSecret() ?? process.env.SLACK_SIGNING_SECRET ?? undefined,
  };
}

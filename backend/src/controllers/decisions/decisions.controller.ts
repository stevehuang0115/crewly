/**
 * Owner decisions API (specs/2026-10-01-decision-cards.md) and the Slack
 * interactivity endpoint.
 *
 * - POST /api/decisions               — ask the owner (agents: X-Agent-Session)
 * - GET  /api/decisions?status=open   — open + parked (default) or `all`
 * - GET  /api/decisions/:id
 * - POST /api/decisions/:id/choose    — `{ option }` (owner only: an owner credential, #999)
 * - POST /api/decisions/:id/remind    — "Remind me tomorrow" (owner only)
 * - POST /api/decisions/:id/skip      — "Skip" (owner only; sensitive / system cards get their safe "No")
 * - POST /api/decisions/skip-all      — `{ olderThan?: ISO, source?: 'backfill' | 'all', dryRun? }` (owner only)
 * - POST /api/decisions/:id/cancel    — withdraw (the asker, the requester, the orchestrator or the owner)
 * - POST /api/slack/interactivity     — a Cloud-forwarded envelope or Slack's signed `payload=` form
 *
 * @module controllers/decisions/decisions.controller
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getCallerIdentity, OwnerAuthRequiredError, ownerAuthRequiredBody } from '../../middleware/caller-identity.middleware.js';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';
import { DecisionError, DecisionService, type BlockActionsPayload, type SkipAllInput } from '../../services/decisions/decision.service.js';

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
    if (err instanceof OwnerAuthRequiredError) {
      res.status(401).json(err.body);
      return;
    }
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
 * Only the owner (dashboard session, phone / portal relay, API token)
 * answers. Agents get 403; a caller with no owner credential 401 (#999 —
 * leaving out `X-Agent-Session` no longer makes a caller the owner).
 *
 * @param req - Request
 * @throws DecisionError(403) for an agent, DecisionError(401) for anyone else
 */
function requireOwner(req: Request): void {
  const { kind } = getCallerIdentity(req);
  if (kind === 'owner' || kind === 'relay-owner') return;
  if (kind === 'agent') throw new DecisionError(403, 'Only the owner answers decisions. Agents ask with ask-owner and wait for the [DECISION] message.');
  throw new OwnerAuthRequiredError(ownerAuthRequiredBody(req));
}

/**
 * Validate a skip-all body.
 *
 * @param body - Request body
 * @returns Filters
 * @throws DecisionError(400)
 */
export function parseSkipAllBody(body: unknown): SkipAllInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: SkipAllInput = {};
  if (b.olderThan !== undefined && b.olderThan !== null && b.olderThan !== '') {
    const at = typeof b.olderThan === 'string' || typeof b.olderThan === 'number' ? new Date(b.olderThan) : new Date(NaN);
    if (Number.isNaN(at.getTime())) throw new DecisionError(400, 'olderThan must be an ISO date-time');
    out.olderThan = at;
  }
  if (b.source !== undefined) {
    if (b.source !== 'backfill' && b.source !== 'all') throw new DecisionError(400, "source must be 'backfill' or 'all'");
    out.source = b.source;
  }
  if (b.dryRun !== undefined) {
    if (typeof b.dryRun !== 'boolean') throw new DecisionError(400, 'dryRun must be true or false');
    out.dryRun = b.dryRun;
  }
  return out;
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
  router.post('/skip-all', (req, res) =>
    respond(res, 200, async () => {
      requireOwner(req);
      return svc(deps).skipAll(parseSkipAllBody(req.body));
    }),
  );
  router.post('/:id/skip', (req, res) =>
    respond(res, 200, async () => {
      requireOwner(req);
      return svc(deps).skipFromDashboard(req.params.id);
    }),
  );
  router.post('/:id/cancel', (req, res) =>
    respond(res, 200, async () => {
      const s = svc(deps);
      const d = await s.get(req.params.id);
      if (!d) throw new DecisionError(404, `Decision ${req.params.id} not found`);
      const identity = getCallerIdentity(req);
      if (identity.kind !== 'owner' && identity.kind !== 'relay-owner') {
        const caller = readAgentSessionHeader(req);
        if (!caller && identity.kind !== 'agent') throw new OwnerAuthRequiredError(ownerAuthRequiredBody(req));
        if (!caller) throw new DecisionError(403, `Only ${d.asker} (who asked) can withdraw ${d.id}`);
        if (caller !== d.asker && caller !== d.requestedBy && caller !== ORCHESTRATOR_SESSION_NAME) {
          throw new DecisionError(403, `Only ${d.asker} (who asked) can withdraw ${d.id}`);
        }
      }
      // `note` or `reason`: either names why (shown on the card as "Closed — <why>").
      const why = [req.body?.note, req.body?.reason].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
      await s.cancelWhere((x) => x.id === d.id, why);
      return s.get(d.id);
    }),
  );
  return router;
}

/**
 * POST /api/slack/interactivity. Accepts:
 * - a Cloud `slack_event` envelope (`{ event: { type: 'block_actions' }, interaction }`) —
 *   only with the in-memory cloud / relay credential or an owner credential
 *   (the relay normally delivers these in-process). Being on loopback is not
 *   enough: every agent is (#999);
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
      const { kind } = getCallerIdentity(req);
      if (kind !== 'cloud' && kind !== 'relay-owner' && kind !== 'owner') {
        res.status(401).json({ success: false, error: 'forwarded payloads need the Cloud forwarder\'s credential' });
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

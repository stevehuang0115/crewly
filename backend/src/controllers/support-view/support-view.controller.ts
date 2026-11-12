/**
 * Support view routes (`support-view-instance` skill, crewly#1558): an agent
 * of this machine reads a machine of an account that gave THIS account
 * support access. Read only.
 *
 * - `GET /api/support-view/grants` — the access this account received, with
 *   the machines of each
 * - `GET /api/support-view/agents` — the agents of the granted machine
 * - `GET /api/support-view/conversations?limit=` — its conversations
 * - `GET /api/support-view/conversations/:id/messages?limit=&older=` — one
 *   conversation's messages, newest page first; `older` is the cursor a page
 *   returned
 * - `GET /api/support-view/errors?limit=` — its recent error lines
 *
 * Every read takes `grant` and `machine` when this account has more than one.
 * The caller is the calling agent (caller identity, never the query); a
 * request without one is refused.
 *
 * `specs/2026-11-12-support-access-agent-read.md`
 *
 * @module controllers/support-view/support-view.controller
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getSupportViewService } from '../../services/support/support.wiring.js';
import { SupportViewError, SUPPORT_VIEW_STATUS, SUPPORT_VIEW_TEXT, type SupportRead } from '../../services/support/support-client.types.js';
import type { SupportViewService } from '../../services/support/support-view.service.js';

const V = SUPPORT_VIEW_CONSTANTS;
const F = V.FAILURES;

/**
 * A single string query value.
 *
 * @param value - `req.query[...]`
 * @returns The trimmed string, or undefined when absent, empty or repeated
 */
function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A whole-number query value.
 *
 * @param value - `req.query[...]`
 * @returns The number, or undefined when absent
 * @throws SupportViewError `invalid` when it is not a positive whole number
 */
function queryCount(value: unknown): number | undefined {
  const raw = queryString(value);
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) < 1) throw new SupportViewError(F.INVALID, 'limit must be a positive whole number.');
  return Number(raw);
}

/**
 * Send a failure as the skill reads it.
 *
 * @param res - Response
 * @param error - The failure
 */
function sendFailure(res: Response, error: SupportViewError): void {
  res.status(error.status).json({
    success: false,
    code: error.code,
    error: error.message,
    ...(error.choices && error.choices.length > 0 ? { choices: error.choices } : {}),
  });
}

/**
 * Run one support view call for the calling agent and answer it.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Express next (unexpected errors)
 * @param run - The call, given the service and the caller's session
 */
async function answer(
  req: Request,
  res: Response,
  next: NextFunction,
  run: (service: SupportViewService, session: string) => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const service = getSupportViewService();
    if (!service) {
      res.status(SUPPORT_VIEW_STATUS[F.NOT_CONNECTED]).json({ success: false, code: F.NOT_CONNECTED, error: SUPPORT_VIEW_TEXT[F.NOT_CONNECTED] });
      return;
    }
    const session = readAgentSessionHeader(req);
    if (!session) {
      res.status(403).json({ success: false, code: F.INVALID, error: 'Only an agent can read another account\'s machine through support access.' });
      return;
    }
    res.json({ success: true, ...(await run(service, session)) });
  } catch (error) {
    if (error instanceof SupportViewError) {
      sendFailure(res, error);
      return;
    }
    next(error);
  }
}

/**
 * Run one read and shape its answer.
 *
 * @param req - Request (`grant`, `machine` in the query)
 * @param service - Support view
 * @param session - Calling agent session
 * @param read - What to read
 * @returns `{ grant, machine, data }`
 */
async function runRead(req: Request, service: SupportViewService, session: string, read: SupportRead): Promise<Record<string, unknown>> {
  const result = await service.read(session, { grant: queryString(req.query.grant), machine: queryString(req.query.machine) }, read);
  return { grant: result.grant, machine: result.machine, data: result.data };
}

/** @returns The router mounted at `/api/support-view` */
export function createSupportViewRouter(): Router {
  const router = Router();

  router.get('/grants', (req, res, next) =>
    answer(req, res, next, async (service, session) => ({ grants: await service.grants(session) })));

  router.get('/agents', (req, res, next) =>
    answer(req, res, next, (service, session) => runRead(req, service, session, { area: V.AREAS.AGENTS })));

  router.get('/conversations', (req, res, next) =>
    answer(req, res, next, (service, session) => {
      const limit = queryCount(req.query.limit);
      return runRead(req, service, session, { area: V.AREAS.CONVERSATIONS, ...(limit !== undefined ? { limit } : {}) });
    }));

  router.get('/conversations/:id/messages', (req, res, next) =>
    answer(req, res, next, (service, session) => {
      const limit = queryCount(req.query.limit);
      const older = queryString(req.query.older);
      return runRead(req, service, session, {
        area: V.AREAS.MESSAGES,
        conversationId: req.params.id,
        ...(limit !== undefined ? { limit } : {}),
        ...(older !== undefined ? { older } : {}),
      });
    }));

  router.get('/errors', (req, res, next) =>
    answer(req, res, next, (service, session) => {
      const limit = queryCount(req.query.limit);
      return runRead(req, service, session, { area: V.AREAS.ERRORS, ...(limit !== undefined ? { limit } : {}) });
    }));

  return router;
}

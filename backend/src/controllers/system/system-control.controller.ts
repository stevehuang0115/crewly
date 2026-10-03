/**
 * Owner-only Upgrade / Restart endpoints
 * (specs/2026-10-01-upgrade-restart-controls.md).
 *
 * - `GET  /api/system/update-status`  — versions, install kind, relauncher, busy agents, progress
 * - `POST /api/system/upgrade { when }` — npm global installs only; 409 on a source checkout
 * - `POST /api/system/restart { when }` — graceful drained restart that always comes back
 *
 * Owner only (#999): agents get 403 and a caller without an owner
 * credential (dashboard session, relay, API token) gets 401. Non-loopback
 * callers still need the API token (the global API-token middleware in front
 * of `/api`).
 *
 * @module controllers/system/system-control
 */

import type { Request, Response, Router } from 'express';
import { SYSTEM_CONTROL_CONSTANTS, TICKET_CONSTANTS } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getCallerIdentity, rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { getClientAddress } from '../../middleware/api-token.middleware.js';
import { LoggerService } from '../../services/core/logger.service.js';
import {
	SystemControlService,
	type SystemActionWhen,
	type SystemActionAccepted,
	type SystemActionRefusal,
} from '../../services/system/system-control.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SystemControl');

/**
 * Let only the owner through: agents get 403, a caller with no owner
 * credential 401 (#999 — a missing `X-Agent-Session` is not the owner).
 *
 * @param req - Request
 * @param res - Response
 * @param action - What was attempted (log)
 * @returns True when the caller may proceed
 */
export function ensureOwnerCaller(req: Request, res: Response, action: string): boolean {
	const refused = rejectNonOwner(req, res, {
		success: false,
		code: SYSTEM_CONTROL_CONSTANTS.CODES.OWNER_ONLY,
		error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.OWNER_ONLY,
	});
	if (refused) {
		logger.warn(`Refused ${action} from a non-owner caller`, {
			agentSession: readAgentSessionHeader(req),
			kind: getCallerIdentity(req).kind,
			address: getClientAddress(req),
		});
	}
	return !refused;
}

/**
 * Who pressed the button, for the logs and the progress record.
 *
 * @param req - Request
 * @returns e.g. `dashboard from 192.168.1.20`, `phone (relay)`, `api from 127.0.0.1`
 */
export function describeActor(req: Pick<Request, 'headers' | 'socket'>): string {
	const header = (name: string): string | undefined => {
		const v = req.headers[name];
		return Array.isArray(v) ? v[0] : v;
	};
	const identity = getCallerIdentity(req as Request);
	if (identity.kind === 'relay-owner' || header(TICKET_CONSTANTS.CLIENT_HEADER) === TICKET_CONSTANTS.MOBILE_CLIENT) return 'phone (relay)';
	const who = identity.via === 'owner-session' ? 'dashboard' : 'api';
	const address = getClientAddress(req as Request);
	return address ? `${who} from ${address}` : who;
}

/**
 * Parse the `when` body field (default `idle`).
 *
 * @param body - Request body
 * @returns The value, or null when invalid
 */
export function parseWhen(body: unknown): SystemActionWhen | null {
	const raw = body && typeof body === 'object' ? (body as { when?: unknown }).when : undefined;
	if (raw === undefined || raw === null || raw === '') return 'idle';
	return (SYSTEM_CONTROL_CONSTANTS.WHEN_VALUES as readonly unknown[]).includes(raw) ? (raw as SystemActionWhen) : null;
}

/**
 * The service, or a 503.
 *
 * @param res - Response
 * @returns The service or null (answered)
 */
function serviceOr503(res: Response): SystemControlService | null {
	const svc = SystemControlService.getInstance();
	if (!svc) {
		res.status(503).json({
			success: false,
			code: SYSTEM_CONTROL_CONSTANTS.CODES.UNAVAILABLE,
			error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.UNAVAILABLE,
		});
	}
	return svc;
}

/**
 * Send an accepted / refused action answer.
 *
 * @param res - Response
 * @param result - Service answer
 */
function sendResult(res: Response, result: SystemActionAccepted | SystemActionRefusal): void {
	if (result.ok) {
		res.status(202).json({ success: true, data: { action: result.action, escalated: result.escalated === true } });
		return;
	}
	res.status(result.httpStatus).json({ success: false, code: result.code, error: result.error });
}

/**
 * GET /api/system/update-status[?refresh=1]
 *
 * @param req - Request
 * @param res - `{ success, data: UpdateStatus }`
 */
export async function getUpdateStatus(req: Request, res: Response): Promise<void> {
	if (!ensureOwnerCaller(req, res, 'update-status')) return;
	const svc = serviceOr503(res);
	if (!svc) return;
	try {
		const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
		res.json({ success: true, data: await svc.getStatus({ refresh }) });
	} catch (error) {
		logger.error('update-status failed', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({ success: false, error: 'Could not read the update status' });
	}
}

/**
 * Shared body of the two POSTs.
 *
 * @param kind - upgrade or restart
 * @param req - Request
 * @param res - Response
 */
async function handleAction(kind: 'upgrade' | 'restart', req: Request, res: Response): Promise<void> {
	if (!ensureOwnerCaller(req, res, kind)) return;
	const when = parseWhen(req.body);
	if (!when) {
		res.status(400).json({ success: false, code: SYSTEM_CONTROL_CONSTANTS.CODES.BAD_REQUEST, error: "`when` must be 'idle' or 'now'" });
		return;
	}
	const svc = serviceOr503(res);
	if (!svc) return;
	const actor = describeActor(req);
	try {
		const result = kind === 'upgrade' ? await svc.requestUpgrade({ when, actor }) : await svc.requestRestart({ when, actor });
		logger.info(`POST /api/system/${kind}`, {
			when,
			requestedBy: actor,
			accepted: result.ok,
			...(result.ok ? { actionId: result.action.id, escalated: result.escalated === true } : { code: result.code, error: result.error }),
		});
		sendResult(res, result);
	} catch (error) {
		logger.error(`${kind} request failed`, { error: error instanceof Error ? error.message : String(error), requestedBy: actor });
		res.status(500).json({ success: false, error: `Could not start the ${kind}` });
	}
}

/**
 * POST /api/system/upgrade `{ when: 'idle' | 'now' }`
 *
 * @param req - Request
 * @param res - 202 `{ success, data: { action } }`, or 400/403/409/502/503
 */
export function postUpgrade(req: Request, res: Response): Promise<void> {
	return handleAction('upgrade', req, res);
}

/**
 * POST /api/system/restart `{ when: 'idle' | 'now' }`
 *
 * @param req - Request
 * @param res - 202 `{ success, data: { action } }`, or 400/403/409/503
 */
export function postRestart(req: Request, res: Response): Promise<void> {
	return handleAction('restart', req, res);
}

/**
 * Register the three routes on an `/api` router.
 *
 * @param router - Router mounted at `/api`
 */
export function registerSystemControlRoutes(router: Router): void {
	router.get('/system/update-status', (req, res) => void getUpdateStatus(req, res));
	router.post('/system/upgrade', (req, res) => void postUpgrade(req, res));
	router.post('/system/restart', (req, res) => void postRestart(req, res));
}

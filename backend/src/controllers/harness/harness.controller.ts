/**
 * Harness controller — REST handlers for `/api/harness` (web setup page).
 *
 * Contract: specs/onboarding-harness-login.md. Every response is
 * `{ success: true, data }` or `{ success: false, error }`.
 *
 * Owner-only: install, orc choice, every login route and the API-key route
 * refuse a request that carries an `X-Agent-Session` header (403) — an agent
 * must not install software, switch the orchestrator's harness or log the
 * machine in. This mirrors the tickets controller's owner check. `GET
 * /api/harness` and `GET /api/harness/install/:jobId` stay readable.
 *
 * API keys are never echoed; errors never contain them.
 *
 * @module controllers/harness/harness.controller
 */

import type { Request, Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { HarnessApiKeyError } from '../../services/harness/harness-api-key.service.js';
import { HarnessInstallError } from '../../services/harness/harness-install.service.js';
import { HarnessService, UnknownHarnessError, getHarnessService } from '../../services/harness/harness.service.js';
import { LoginBrokerError } from '../../services/harness/login-broker.service.js';

/** HTTP status for each service error code. */
const ERROR_STATUS: Record<string, number> = {
	unknown_harness: 404,
	job_not_found: 404,
	not_found: 404,
	unsupported_method: 400,
	unsupported: 400,
	invalid_key: 400,
	not_installed: 409,
	not_active: 409,
	login_failed: 422,
	spawn_failed: 500,
};

/** Handlers bound to a harness service. */
export interface HarnessController {
	getOverview(req: Request, res: Response): Promise<void>;
	startInstall(req: Request, res: Response): Promise<void>;
	getInstallJob(req: Request, res: Response): Promise<void>;
	setOrcHarness(req: Request, res: Response): Promise<void>;
	startLogin(req: Request, res: Response): Promise<void>;
	getLogin(req: Request, res: Response): Promise<void>;
	inputLogin(req: Request, res: Response): Promise<void>;
	cancelLogin(req: Request, res: Response): Promise<void>;
	submitApiKey(req: Request, res: Response): Promise<void>;
}

/**
 * Refuse a request made by an agent session.
 *
 * @param req - Express request
 * @param res - Express response
 * @param what - Action, for the message
 * @returns True when refused (response sent)
 */
export function refuseAgent(req: Request, res: Response, what: string): boolean {
	if (!readAgentSessionHeader(req)) return false;
	res.status(403).json({ success: false, error: `Only the owner can ${what}` });
	return true;
}

/**
 * Send an error response for a thrown error.
 *
 * @param res - Express response
 * @param error - Thrown value
 */
export function sendError(res: Response, error: unknown): void {
	if (error instanceof UnknownHarnessError) {
		res.status(404).json({ success: false, error: error.message });
		return;
	}
	if (error instanceof LoginBrokerError || error instanceof HarnessInstallError || error instanceof HarnessApiKeyError) {
		res.status(ERROR_STATUS[error.code] ?? 500).json({ success: false, error: error.message, code: error.code });
		return;
	}
	res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal error' });
}

/**
 * Read a string route param.
 *
 * @param req - Express request
 * @param name - Param name
 * @returns The value ('' when missing)
 */
function param(req: Request, name: string): string {
	const value = req.params[name];
	return typeof value === 'string' ? value : '';
}

/**
 * Build the controller.
 *
 * @param getService - Service accessor (defaults to the backend singleton; resolved per request)
 * @returns Handlers
 */
export function createHarnessController(getService: () => HarnessService = getHarnessService): HarnessController {
	return {
		/** GET / — statuses, orc harness, system tools */
		async getOverview(_req, res) {
			try {
				res.json({ success: true, data: await getService().getOverview() });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /:id/install — start an install job */
		async startInstall(req, res) {
			if (refuseAgent(req, res, 'install harnesses')) return;
			try {
				const job = getService().startInstall(param(req, 'id'));
				res.json({ success: true, data: { jobId: job.jobId } });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** GET /install/:jobId — install job progress */
		async getInstallJob(req, res) {
			try {
				res.json({ success: true, data: getService().getInstallJob(param(req, 'jobId')) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** PUT /orc — choose the orchestrator's harness */
		async setOrcHarness(req, res) {
			if (refuseAgent(req, res, 'choose the orchestrator harness')) return;
			const harnessId = (req.body as { harnessId?: unknown } | undefined)?.harnessId;
			if (typeof harnessId !== 'string' || harnessId.length === 0) {
				res.status(400).json({ success: false, error: 'harnessId is required' });
				return;
			}
			try {
				const orcHarness = await getService().setOrcHarness(harnessId);
				res.json({ success: true, data: { orcHarness } });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /:id/login — start a broker login */
		async startLogin(req, res) {
			if (refuseAgent(req, res, 'log harnesses in')) return;
			const method = (req.body as { method?: unknown } | undefined)?.method;
			if (typeof method !== 'string' || method.length === 0) {
				res.status(400).json({ success: false, error: 'method is required' });
				return;
			}
			try {
				res.json({ success: true, data: getService().startLogin(param(req, 'id'), method) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** GET /login/:sessionId — login session state */
		async getLogin(req, res) {
			if (refuseAgent(req, res, 'read harness logins')) return;
			try {
				res.json({ success: true, data: getService().broker.get(param(req, 'sessionId')) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /login/:sessionId/input — type the user's reply */
		async inputLogin(req, res) {
			if (refuseAgent(req, res, 'log harnesses in')) return;
			const text = (req.body as { text?: unknown } | undefined)?.text;
			if (typeof text !== 'string' || text.trim().length === 0) {
				res.status(400).json({ success: false, error: 'text is required' });
				return;
			}
			try {
				res.json({ success: true, data: getService().broker.input(param(req, 'sessionId'), text.trim()) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /login/:sessionId/cancel — cancel a login */
		async cancelLogin(req, res) {
			if (refuseAgent(req, res, 'cancel harness logins')) return;
			try {
				res.json({ success: true, data: getService().broker.cancel(param(req, 'sessionId')) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /:id/api-key — validate and store an API key (never echoed) */
		async submitApiKey(req, res) {
			if (refuseAgent(req, res, 'set harness API keys')) return;
			const key = (req.body as { key?: unknown } | undefined)?.key;
			if (typeof key !== 'string' || key.trim().length === 0) {
				res.status(400).json({ success: false, error: 'key is required' });
				return;
			}
			try {
				res.json({ success: true, data: await getService().submitApiKey(param(req, 'id'), key) });
			} catch (error) {
				sendError(res, error);
			}
		},
	};
}

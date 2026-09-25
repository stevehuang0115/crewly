/**
 * Onboarding checklist controller — REST handlers for the first-run
 * checklist (specs/onboarding-harness-login.md, Phase 3).
 *
 * Every response is `{ success: true, data }` or `{ success: false, error, code? }`.
 *
 * Owner-only: every mutation refuses a request that carries an
 * `X-Agent-Session` header (403), the way `/api/harness` does — an agent
 * must not create the owner's team, speak as the owner to the orchestrator
 * or hide the owner's checklist. The two GETs stay readable.
 *
 * @module controllers/onboarding/onboarding-checklist.controller
 */

import type { Request, Response } from 'express';
import { refuseAgent } from '../harness/harness.controller.js';
import {
	OnboardingError,
	type OnboardingChecklistService,
	type OnboardingErrorCode,
} from '../../services/onboarding/onboarding-checklist.service.js';

/** HTTP status for each service error code. */
const ERROR_STATUS: Record<OnboardingErrorCode, number> = {
	unknown_starter: 404,
	unknown_team: 404,
	invalid_task: 400,
};

/** Handlers bound to a checklist service. */
export interface OnboardingChecklistController {
	getChecklist(req: Request, res: Response): Promise<void>;
	setDismissed(req: Request, res: Response): Promise<void>;
	listStarters(req: Request, res: Response): Promise<void>;
	createStarterTeam(req: Request, res: Response): Promise<void>;
	sendFirstTask(req: Request, res: Response): Promise<void>;
}

/**
 * Send an error response for a thrown error.
 *
 * @param res - Express response
 * @param error - Thrown value
 */
export function sendOnboardingError(res: Response, error: unknown): void {
	if (error instanceof OnboardingError) {
		res.status(ERROR_STATUS[error.code] ?? 400).json({ success: false, error: error.message, code: error.code });
		return;
	}
	res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
}

/**
 * Build the handlers.
 *
 * @param getService - Service accessor (tests inject a fake)
 * @returns Handlers
 */
export function createOnboardingChecklistController(getService: () => OnboardingChecklistService): OnboardingChecklistController {
	return {
		/** GET /checklist — every step, read from the live system. */
		async getChecklist(_req, res) {
			try {
				res.json({ success: true, data: await getService().getChecklist() });
			} catch (error) {
				sendOnboardingError(res, error);
			}
		},

		/** POST /checklist/dismiss { dismissed?: boolean } — hide (default) or show the dashboard card. */
		async setDismissed(req, res) {
			if (refuseAgent(req, res, 'hide the setup checklist')) return;
			try {
				const dismissed = req.body?.dismissed !== false;
				res.json({ success: true, data: await getService().setDismissed(dismissed) });
			} catch (error) {
				sendOnboardingError(res, error);
			}
		},

		/** GET /starters — starter teams (templates marked `onboarding`, then Blank). */
		async listStarters(_req, res) {
			try {
				res.json({ success: true, data: { starters: getService().listStarters() } });
			} catch (error) {
				sendOnboardingError(res, error);
			}
		},

		/** POST /starter-team { starterId } — create the first team (or record Blank). */
		async createStarterTeam(req, res) {
			if (refuseAgent(req, res, 'create the first team')) return;
			const starterId = req.body?.starterId;
			if (typeof starterId !== 'string' || starterId.length === 0) {
				res.status(400).json({ success: false, error: 'starterId is required' });
				return;
			}
			try {
				const result = await getService().createStarterTeam(starterId);
				res.status(result.created ? 201 : 200).json({ success: true, data: result });
			} catch (error) {
				sendOnboardingError(res, error);
			}
		},

		/** POST /first-task { text, teamId? } — hand the owner's first task to the orchestrator. */
		async sendFirstTask(req, res) {
			if (refuseAgent(req, res, 'send the first task')) return;
			try {
				const result = await getService().sendFirstTask(req.body?.text, req.body?.teamId);
				res.status(result.forwarded ? 201 : 503).json(
					result.forwarded
						? { success: true, data: result }
						: { success: false, error: result.message ?? 'The orchestrator could not take the task', data: result },
				);
			} catch (error) {
				sendOnboardingError(res, error);
			}
		},
	};
}

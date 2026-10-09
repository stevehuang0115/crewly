/**
 * Drive mode voice token (specs/2026-10-08-drive-mode.md §3), mounted at
 * `/api/talk/live-token` and reached from the portal over the relay.
 *
 * - `GET  /status` — `{ hasKey, model }` (no network)
 * - `POST /`       — `{ language? }` → a Gemini Live ephemeral token locked to the briefer
 *
 * Owner only: an agent gets 403, a caller without an owner credential 401.
 * The API key never leaves this machine; the token is never logged.
 *
 * @module controllers/talk/talk-live-token.controller
 */

import { Router, type Request, type Response } from 'express';
import { TALK_LIVE_CONSTANTS } from '../../constants.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { getTalkLiveTokenService, parseLiveLanguage, TalkLiveTokenError } from '../../services/talk/talk-live-token.service.js';

const C = TALK_LIVE_CONSTANTS;

/**
 * Refuse callers that are not the owner.
 *
 * @param req - Request
 * @param res - Response
 * @returns True when refused (response written)
 */
function refuseNonOwner(req: Request, res: Response): boolean {
	return rejectNonOwner(req, res, { success: false, code: C.CODES.OWNER_ONLY, error: 'Only the owner can use Drive mode.' });
}

/**
 * GET /api/talk/live-token/status
 *
 * @param req - Request
 * @param res - Response
 */
export function getLiveTokenStatus(req: Request, res: Response): void {
	if (refuseNonOwner(req, res)) return;
	const service = getTalkLiveTokenService();
	res.json({ success: true, data: { hasKey: service.hasKey(), model: service.buildSetup(C.DEFAULT_LANGUAGE).model.replace(/^models\//, '') } });
}

/**
 * POST /api/talk/live-token — mint one token.
 *
 * @param req - Request (`{ language? }`)
 * @param res - Response
 */
export async function mintLiveToken(req: Request, res: Response): Promise<void> {
	if (refuseNonOwner(req, res)) return;
	const language = parseLiveLanguage((req.body ?? {}).language);
	try {
		res.json({ success: true, data: await getTalkLiveTokenService().mint(language) });
	} catch (error) {
		if (error instanceof TalkLiveTokenError) {
			res.status(error.status).json({ success: false, code: error.code, error: error.message });
			return;
		}
		res.status(500).json({ success: false, code: C.CODES.FAILED, error: 'Could not start the voice session.' });
	}
}

/**
 * Create the live-token router.
 *
 * @returns Express router
 */
export function createTalkLiveTokenRouter(): Router {
	const router = Router();
	router.get('/status', getLiveTokenStatus);
	router.post('/', mintLiveToken);
	return router;
}

/**
 * Drive mode briefing API (specs/2026-10-08-drive-mode.md), mounted at
 * `/api/briefing` and reached from the portal over the relay.
 *
 * - `GET  /`              — the owner's queue, ordered by urgency then age
 * - `POST /:id/answer`    — `{ optionKey? , text?, confirm?, confirmToken? }`
 * - `POST /:id/skip`      — `{ dismiss? }` — next (hide for a while) / drop it
 * - `POST /:id/later`     — `{ at?: ISO }` — remind later (default tomorrow morning)
 * - `POST /:id/ask`       — `{ question }` — hand a follow-up to the agent
 *
 * Owner only: an agent gets 403, a caller without an owner credential 401.
 * Nothing the owner says is logged.
 *
 * @module controllers/briefing/briefing.controller
 */

import { Router, type Request, type Response } from 'express';
import { BRIEFING_CONSTANTS } from '../../constants.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { BriefingError } from '../../services/briefing/briefing.types.js';
import { getBriefingService, type BriefingService } from '../../services/briefing/briefing.service.js';

const C = BRIEFING_CONSTANTS;

/**
 * Run an owner-only handler and map its errors.
 *
 * @param req - Request
 * @param res - Response
 * @param fn - Handler given the running service
 */
async function handle(req: Request, res: Response, fn: (service: BriefingService) => Promise<unknown>): Promise<void> {
	if (rejectNonOwner(req, res, { success: false, code: C.CODES.OWNER_ONLY, error: 'Only the owner can use Drive mode.' })) return;
	const service = getBriefingService();
	if (!service) {
		res.status(503).json({ success: false, code: C.CODES.NOT_READY, error: 'Drive mode is not ready yet — Crewly is still starting.' });
		return;
	}
	try {
		res.json({ success: true, data: await fn(service) });
	} catch (error) {
		if (error instanceof BriefingError) {
			res.status(error.status).json({ success: false, code: error.code, error: error.message });
			return;
		}
		res.status(500).json({ success: false, code: C.CODES.FAILED, error: 'That did not work.' });
	}
}

/**
 * The request body as an object.
 *
 * @param req - Request
 * @returns Body
 */
function body(req: Request): Record<string, unknown> {
	return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

/**
 * Create the briefing router.
 *
 * @returns Express router
 */
export function createBriefingRouter(): Router {
	const router = Router();
	router.get('/', (req, res) => handle(req, res, (s) => s.queue()));
	router.post('/:id/answer', (req, res) =>
		handle(req, res, (s) => {
			const b = body(req);
			return s.answer(req.params.id, {
				optionKey: b.optionKey as string | undefined,
				text: b.text as string | undefined,
				confirm: b.confirm === true,
				confirmToken: b.confirmToken as string | undefined,
			});
		}),
	);
	router.post('/:id/skip', (req, res) => handle(req, res, (s) => s.skip(req.params.id, { dismiss: body(req).dismiss === true })));
	router.post('/:id/later', (req, res) => handle(req, res, (s) => s.later(req.params.id, { at: body(req).at })));
	router.post('/:id/ask', (req, res) => handle(req, res, (s) => s.ask(req.params.id, body(req).question)));
	return router;
}

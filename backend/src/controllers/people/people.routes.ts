/**
 * People directory API (issue #968).
 *
 * - `GET    /api/people`      — everyone, owner first: `{ people, ownerId }`
 * - `PUT    /api/people/:id`  — add or edit a person `{ name?, role? }`
 * - `DELETE /api/people/:id`  — remove a person
 *
 * Reading is open to agents (they use names); changing it is the owner's
 * alone: a request from an agent session is refused, so an agent can never
 * promote a guest or itself.
 *
 * specs/per-person-access.md
 *
 * @module controllers/people/people.routes
 */

import { Router, type Request, type Response } from 'express';
import { getPeopleDirectory, PeopleDirectoryError, type PeopleDirectoryService } from '../../services/people/people-directory.service.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/**
 * Refuse a change made by an agent.
 *
 * @param req - Request
 * @param res - Response
 * @returns True when refused (response sent)
 */
function refuseAgent(req: Request, res: Response): boolean {
	if (!readAgentSessionHeader(req)) return false;
	res.status(403).json({ success: false, error: 'owner_only', message: 'Only the owner can change the people directory (Settings › People).' });
	return true;
}

/**
 * Send a directory error.
 *
 * @param res - Response
 * @param err - Error
 */
function sendError(res: Response, err: unknown): void {
	if (err instanceof PeopleDirectoryError) {
		res.status(400).json({ success: false, error: err.message });
		return;
	}
	res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * Build the router.
 *
 * @param directory - The directory (default: the backend's)
 * @returns Router for `/api/people`
 */
export function createPeopleRouter(directory: () => PeopleDirectoryService = getPeopleDirectory): Router {
	const router = Router();

	router.get('/', (_req: Request, res: Response) => {
		try {
			const dir = directory();
			res.json({ success: true, data: { people: dir.list(), ownerId: dir.ownerId() } });
		} catch (err) {
			sendError(res, err);
		}
	});

	router.put('/:id', (req: Request, res: Response) => {
		if (refuseAgent(req, res)) return;
		try {
			const body = (req.body ?? {}) as { name?: unknown; role?: unknown };
			res.json({ success: true, data: directory().upsert(req.params.id, { name: body.name, role: body.role }) });
		} catch (err) {
			sendError(res, err);
		}
	});

	router.delete('/:id', (req: Request, res: Response) => {
		if (refuseAgent(req, res)) return;
		try {
			const removed = directory().remove(req.params.id);
			if (!removed) {
				res.status(404).json({ success: false, error: 'No such person' });
				return;
			}
			res.json({ success: true, data: { removed: true } });
		} catch (err) {
			sendError(res, err);
		}
	});

	return router;
}

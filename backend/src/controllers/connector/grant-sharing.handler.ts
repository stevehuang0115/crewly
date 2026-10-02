/**
 * Shared pieces of the per-person connector routes (issue #968): who a new
 * grant belongs to, and the owner-only "change owner / sharing" handler the
 * Google, Canva and Microsoft routers mount at `POST /sharing`.
 *
 * specs/2026-10-03-per-person-access.md
 *
 * @module controllers/connector/grant-sharing.handler
 */

import type { Request, Response } from 'express';
import { PEOPLE_CONSTANTS } from '../../constants.js';
import { getActingFor } from '../../services/people/acting-for.service.js';
import { GrantSharingError, validateAuthorizedBy, validateSharing, type GrantOwnership, type GrantSharing } from '../../services/people/grant-sharing.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/** A validated ownership / sharing change. */
export interface GrantSharingChange {
	authorizedBy?: string;
	sharing?: GrantSharing;
}

/**
 * The person a grant connected through this request will belong to: the
 * owner from the dashboard, else the person the asking agent acts for.
 *
 * @param req - Incoming request
 * @returns Person id (the owner when it cannot be read)
 */
export function connectingPerson(req: Pick<Request, 'headers'>): string {
	try {
		return getActingFor().actorFor(readAgentSessionHeader(req)).id;
	} catch {
		return PEOPLE_CONSTANTS.OWNER_ID;
	}
}

/**
 * Read and validate a change from a request body.
 *
 * @param body - `{ authorizedBy?, sharing? }` (untrusted)
 * @returns The change
 * @throws GrantSharingError when invalid or empty
 */
export function readSharingChange(body: unknown): GrantSharingChange {
	const b = (body ?? {}) as { authorizedBy?: unknown; sharing?: unknown };
	const change: GrantSharingChange = {
		...(b.authorizedBy !== undefined ? { authorizedBy: validateAuthorizedBy(b.authorizedBy) } : {}),
		...(b.sharing !== undefined ? { sharing: validateSharing(b.sharing) } : {}),
	};
	if (!change.authorizedBy && !change.sharing) throw new GrantSharingError('Send authorizedBy and/or sharing');
	return change;
}

/**
 * Build the owner-only `POST /sharing` handler for a connector.
 *
 * @param apply - Sends the change to Cloud (the connector's token service)
 * @param sendError - The connector's error responder
 * @returns Express handler
 */
export function createSharingHandler(
	apply: (req: Request, change: GrantSharingChange) => Promise<GrantOwnership>,
	sendError: (req: Request, res: Response, err: unknown) => void,
): (req: Request, res: Response) => Promise<void> {
	return async (req, res) => {
		if (readAgentSessionHeader(req)) {
			res.status(403).json({ success: false, error: 'owner_only', message: 'Only the owner can change who a connection is shared with (Connections).' });
			return;
		}
		let change: GrantSharingChange;
		try {
			change = readSharingChange(req.body);
		} catch (err) {
			res.status(400).json({ success: false, error: 'validation', message: err instanceof Error ? err.message : String(err) });
			return;
		}
		try {
			res.json({ success: true, data: await apply(req, change) });
		} catch (err) {
			sendError(req, res, err);
		}
	};
}

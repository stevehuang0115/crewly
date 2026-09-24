/**
 * Restart readiness endpoint.
 *
 * `GET /api/system/restart-readiness` answers "can I restart now without
 * cutting an agent off mid-turn?". Check it before restarting — an empty
 * message queue is not the same answer: a delivered message has left the
 * queue while the agent is still working on it (2026-09-24, Ella).
 *
 * @module controllers/system/restart-readiness
 */

import type { Request, Response } from 'express';
import { RestartDrainService } from '../../services/restart/restart-drain.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('RestartReadinessController');

/**
 * Report whether a restart is safe now.
 *
 * Response: `{ safe, busyAgents: [{ session, since, messagePreview }], queued, draining }`.
 * `queued` counts messages on the persistent queues — they survive a restart
 * and do not make it unsafe.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function getRestartReadiness(_req: Request, res: Response): void {
	try {
		res.json(RestartDrainService.getInstance().getReadiness());
	} catch (error) {
		logger.error('Failed to compute restart readiness', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({ success: false, error: 'Failed to compute restart readiness' });
	}
}

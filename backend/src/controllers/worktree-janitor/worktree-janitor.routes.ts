/**
 * Worktree Janitor Routes
 *
 * Debug and manual-trigger endpoints for {@link WorktreeJanitorService},
 * mounted at `/api/worktree-janitor` behind the same API-token middleware as
 * every other `/api` route.
 *
 * - `GET  /api/worktree-janitor/worktrees` — dry run: every worktree of every
 *   known repo with its keep/remove verdict and reason, the stale-scratch
 *   sweep plan (`scratch`), and current free space (`disk`). Removes nothing.
 * - `POST /api/worktree-janitor/run` — one real pass now. Refused (409) while
 *   the `CREWLY_WORKTREE_JANITOR=0` kill switch is on.
 *
 * @module controllers/worktree-janitor/worktree-janitor.routes
 */

import { Router, type Request, type Response } from 'express';
import { WorktreeJanitorService } from '../../services/worktree/worktree-janitor.service.js';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';

/**
 * Create the worktree janitor router.
 *
 * @param getService - Service accessor (tests inject their own)
 * @returns Express router for /api/worktree-janitor
 *
 * @example
 * ```typescript
 * router.use('/worktree-janitor', createWorktreeJanitorRouter());
 * ```
 */
export function createWorktreeJanitorRouter(
	getService: () => WorktreeJanitorService = () => WorktreeJanitorService.getInstance(),
): Router {
	const router = Router();

	router.get('/worktrees', async (_req: Request, res: Response) => {
		try {
			const service = getService();
			const plan = await service.plan();
			const disk = await service.diskStatus();
			res.json({
				success: true,
				data: { ...plan, disk, disabled: service.isDisabled(), lastRun: service.getLastSummary() },
			});
		} catch (error) {
			res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	router.post('/run', async (_req: Request, res: Response) => {
		try {
			const service = getService();
			if (service.isDisabled()) {
				res.status(409).json({
					success: false,
					error: `Worktree janitor is disabled (${WORKTREE_JANITOR_CONSTANTS.ENV_VAR}=0)`,
				});
				return;
			}
			const summary = await service.run();
			res.json({ success: true, data: summary });
		} catch (error) {
			res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	return router;
}

/**
 * Owner controls for the temporary team pause
 * (specs/2026-10-04-team-pause.md):
 *
 * - `POST /api/teams/:id/pause {reason?, until?}` — owner only
 * - `POST /api/teams/:id/resume` — owner only
 * - {@link hidePausedTeamsFromAgents}: `GET /api/teams` hides paused teams
 *   from every agent except the orchestrator (which sees them labelled
 *   `paused (owner)`) and the paused team's own members.
 *
 * @module controllers/team/team-pause.controller
 */

import type { NextFunction, Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import type { Team } from '../../types/index.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { callerAgentSession, rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { isTeamPausedNow, memberSessionKeys } from '../../services/team/team-pause.registry.js';
import {
	TeamPauseError,
	TeamPauseService,
	getTeamPauseService,
	setTeamPauseService,
	type TeamPauseServiceDeps,
} from '../../services/team/team-pause.service.js';
import { stopTeamMemberGracefully } from './team.controller.js';

const logger = LoggerService.getInstance().createComponentLogger('TeamPause');

/**
 * The wired pause service, built from the API context on first use when the
 * server has not installed one yet.
 *
 * @param context - API context
 * @param extra - Optional extra collaborators (the owner notifier)
 * @returns Service
 */
export function ensureTeamPauseService(context: ApiContext, extra: Pick<TeamPauseServiceDeps, 'notifyOwner'> = {}): TeamPauseService {
	const existing = getTeamPauseService();
	if (existing) return existing;
	const service = new TeamPauseService({
		storage: context.storageService,
		stopMember: (team, member) => stopTeamMemberGracefully(context, team, member),
		releaseWorkItems: async (sessions, team) => {
			const { TaskPoolService } = await import('../../services/task-pool/task-pool.service.js');
			return TaskPoolService.getInstance().unassignQueuedForSessions(sessions, `team ${team.name} paused by the owner`);
		},
		releaseTickets: async (sessions, team) => {
			const { projectTicketWorkflow } = await import('../project-tickets/project-tickets.controller.js');
			return projectTicketWorkflow().releaseForPausedTeam(sessions, team.name);
		},
		logger,
		...extra,
	});
	setTeamPauseService(service);
	return service;
}

/**
 * Send a pause / resume error.
 *
 * @param res - Response
 * @param err - Error
 */
function sendError(res: Response, err: unknown): void {
	if (err instanceof TeamPauseError) {
		res.status(err.status).json({ success: false, error: err.message });
		return;
	}
	logger.error('Team pause request failed', { error: err instanceof Error ? err.message : String(err) });
	res.status(500).json({ success: false, error: 'Failed to change the team pause' });
}

/**
 * POST /api/teams/:id/pause — owner only.
 *
 * Body: `{ reason?: string, until?: ISO date-time }`.
 *
 * @param req - Request
 * @param res - Response
 */
export async function pauseTeamHandler(this: ApiContext, req: Request, res: Response): Promise<void> {
	if (rejectNonOwner(req, res, { success: false, error: 'Only the owner can pause a team', code: 'owner_only' })) return;
	try {
		const body = (req.body ?? {}) as { reason?: unknown; until?: unknown };
		const out = await ensureTeamPauseService(this).pause(req.params.id, {
			...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
			...(typeof body.until === 'string' ? { until: body.until } : {}),
		});
		res.json({
			success: true,
			message: `${out.team.name} is paused.${out.stopped.length ? ` Stopped: ${out.stopped.join(', ')}.` : ''}`,
			data: {
				team: out.team,
				alreadyPaused: out.alreadyPaused,
				stopped: out.stopped,
				stopFailed: out.stopFailed,
				releasedWorkItems: out.releasedWorkItems,
				releasedTickets: out.releasedTickets,
			},
		});
	} catch (err) {
		sendError(res, err);
	}
}

/**
 * POST /api/teams/:id/resume — owner only.
 *
 * @param req - Request
 * @param res - Response
 */
export async function resumeTeamHandler(this: ApiContext, req: Request, res: Response): Promise<void> {
	if (rejectNonOwner(req, res, { success: false, error: 'Only the owner can resume a team', code: 'owner_only' })) return;
	try {
		const out = await ensureTeamPauseService(this).resume(req.params.id);
		res.json({
			success: true,
			message: out.wasPaused ? `${out.team.name} is resumed.` : `${out.team.name} was not paused.`,
			data: { team: out.team, wasPaused: out.wasPaused },
		});
	} catch (err) {
		sendError(res, err);
	}
}

/**
 * Whether an agent session is a member of a team.
 *
 * @param team - Team
 * @param session - Agent session
 * @returns True for one of its members
 */
function isMemberOf(team: Team, session: string): boolean {
	return (team.members ?? []).some((m) => memberSessionKeys(team.name, m).includes(session));
}

/**
 * Filter a `GET /api/teams` body for the caller: an agent other than the
 * orchestrator does not see paused teams (unless it is on one).
 *
 * @param body - Response body
 * @param session - Calling agent session, undefined for the owner
 * @returns The body to send
 */
export function filterTeamsBodyForAgent(body: unknown, session: string | undefined): unknown {
	if (!session || session === ORCHESTRATOR_SESSION_NAME) return body;
	const b = body as { data?: unknown } | null;
	if (!b || !Array.isArray(b.data)) return body;
	const data = (b.data as Team[]).filter((t) => !isTeamPausedNow(t) || isMemberOf(t, session));
	return data.length === b.data.length ? body : { ...b, data };
}

/**
 * Middleware for `GET /api/teams`, mounted before the response cache so the
 * cached (owner-shaped) body is filtered per caller too.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next
 */
export function hidePausedTeamsFromAgents(req: Request, res: Response, next: NextFunction): void {
	const session = callerAgentSession(req);
	if (session && session !== ORCHESTRATOR_SESSION_NAME) {
		const original = res.json.bind(res);
		res.json = (body: unknown): Response => original(filterTeamsBodyForAgent(body, session));
	}
	next();
}

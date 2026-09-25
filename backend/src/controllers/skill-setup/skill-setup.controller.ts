/**
 * Skill setup controller — REST handlers for `/api/skill-setup`
 * (specs/skill-auto-install.md). Backs the `find-skill` and `install-skill`
 * agent skills and `crewly skills` when a backend is running.
 *
 * Every response is `{ success: true, data }` or `{ success: false, error, code? }`.
 * Errors are written for the agent reading them: they say what to do next.
 *
 * @module controllers/skill-setup/skill-setup.controller
 */

import type { Request, Response } from 'express';
import { isOwnerDashboardRequest, readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getSkillDiscoveryService, type SkillCandidate, type SkillDiscoveryService } from '../../services/skill-setup/skill-discovery.service.js';
import {
	SkillInstallError,
	describeStartedJob,
	getSkillInstallJobService,
	type SkillInstallJobService,
} from '../../services/skill-setup/skill-install-job.service.js';

/** HTTP status for each install error code. */
const ERROR_STATUS: Record<SkillInstallError['code'], number> = {
	not_found: 404,
	job_not_found: 404,
	owner_approval_required: 403,
	owner_approval_not_found: 403,
	owner_approval_unverifiable: 403,
	invalid_setup: 422,
};

/** Handlers. */
export interface SkillSetupController {
	find(req: Request, res: Response): Promise<void>;
	install(req: Request, res: Response): Promise<void>;
	getJob(req: Request, res: Response): Promise<void>;
	status(req: Request, res: Response): Promise<void>;
}

/** Service accessors (tests inject fakes). */
export interface SkillSetupControllerDeps {
	discovery?: () => SkillDiscoveryService;
	jobs?: () => SkillInstallJobService;
}

/**
 * What the agent should do with a find result, in one line.
 *
 * @param candidates - Ranked candidates
 * @returns Guidance text
 */
export function findGuidance(candidates: SkillCandidate[]): string {
	const top = candidates[0];
	if (!top) return 'No skill matches. Tell the user plainly what you cannot do and why; do not invent a workaround that pretends to work.';
	if (top.ready) return `${top.id} is installed and ready — use it now: bash ${top.executePath}`;
	if (top.official) {
		const minutes = top.setup.estimatedMinutes;
		return (
			`${top.id} is an official skill (${top.officialReason}) that is not ready yet. Tell the user in one line that you are installing it` +
			`${minutes ? ` (about ${minutes} min)` : ''}, then run install-skill --id ${top.id} and continue when the completion message arrives.`
		);
	}
	return `${top.id} is third-party (${top.officialReason}). Ask the owner in chat before installing it; after they say yes run install-skill --id ${top.id} --approved-by-owner.`;
}

/**
 * The owner quote an agent cites (X-Agent-Authorization, `b64:`-encoded by
 * lib.sh because it is often not ASCII). Recorded, never trusted: approval
 * is verified against the owner's chat history.
 *
 * @param req - Request
 * @returns The citation, or undefined
 */
export function readOwnerClaim(req: Request): string | undefined {
	const raw = req.headers['x-agent-authorization'];
	if (typeof raw !== 'string' || raw.length === 0) return undefined;
	if (!raw.startsWith('b64:')) return raw;
	const decoded = Buffer.from(raw.slice(4), 'base64').toString('utf-8');
	return decoded.length > 0 ? decoded : undefined;
}

/**
 * Read a string route param.
 *
 * @param req - Request
 * @param name - Param
 * @returns Value or ''
 */
function param(req: Request, name: string): string {
	const v = req.params[name];
	return typeof v === 'string' ? v : '';
}

/**
 * Send an error.
 *
 * @param res - Response
 * @param error - Thrown value
 */
function sendError(res: Response, error: unknown): void {
	if (error instanceof SkillInstallError) {
		res.status(ERROR_STATUS[error.code] ?? 500).json({ success: false, error: error.message, code: error.code, ...error.details });
		return;
	}
	res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal error' });
}

/**
 * Build the controller.
 *
 * @param deps - Service accessors (default: process singletons, resolved per request)
 * @returns Handlers
 */
export function createSkillSetupController(deps: SkillSetupControllerDeps = {}): SkillSetupController {
	const discovery = deps.discovery ?? getSkillDiscoveryService;
	const jobs = deps.jobs ?? getSkillInstallJobService;
	return {
		/** GET /find?query=…&limit=… — ranked candidates for a need */
		async find(req, res) {
			const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
			if (!query) {
				res.status(400).json({ success: false, error: 'query is required (what you need, e.g. "transcribe a voice message")' });
				return;
			}
			const limitRaw = Number(req.query.limit);
			const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
			try {
				const { candidates, registryAvailable } = await discovery().find(query, { limit });
				res.json({ success: true, data: { query, candidates, registryAvailable, next: findGuidance(candidates) } });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** POST /install { id, approvedByOwner?, resume?, force? } — start a background install */
		async install(req, res) {
			const body = (req.body ?? {}) as { id?: unknown; approvedByOwner?: unknown; resume?: unknown; force?: unknown };
			const id = typeof body.id === 'string' ? body.id.trim() : '';
			if (!id) {
				res.status(400).json({ success: false, error: 'id is required (run find-skill first to get one)' });
				return;
			}
			try {
				const result = await jobs().startInstall({
					skillId: id,
					requesterSession: readAgentSessionHeader(req),
					approvedByOwner: body.approvedByOwner === true,
					ownerDashboard: isOwnerDashboardRequest(req),
					resumeNote: typeof body.resume === 'string' && body.resume.trim() ? body.resume.trim() : undefined,
					force: body.force === true,
					ownerClaim: readOwnerClaim(req),
				});
				if (result.kind === 'already-ready') {
					res.json({
						success: true,
						data: {
							state: 'already-ready',
							skillId: result.skill.id,
							executePath: result.skill.executePath,
							next: `${result.skill.id} is already installed and set up — use it now${result.skill.executePath ? `: bash ${result.skill.executePath}` : ''}.`,
						},
					});
					return;
				}
				const { job } = result;
				res.status(202).json({
					success: true,
					data: {
						jobId: job.jobId,
						skillId: job.skillId,
						state: job.state,
						official: job.official,
						officialReason: job.officialReason,
						estimatedMinutes: job.estimatedMinutes,
						willNotify: job.requesterSessions,
						next: describeStartedJob(job),
					},
				});
			} catch (error) {
				sendError(res, error);
			}
		},

		/** GET /jobs/:jobId — job progress */
		async getJob(req, res) {
			try {
				res.json({ success: true, data: jobs().getJob(param(req, 'jobId')) });
			} catch (error) {
				sendError(res, error);
			}
		},

		/** GET /status/:id — is this skill installed and set up (checks only) */
		async status(req, res) {
			try {
				const skill = await discovery().resolve(param(req, 'id'));
				if (!skill) {
					res.status(404).json({ success: false, error: `Unknown skill: ${param(req, 'id')}`, code: 'not_found' });
					return;
				}
				await discovery().probe(skill);
				res.json({ success: true, data: discovery().publicView(skill) });
			} catch (error) {
				sendError(res, error);
			}
		},
	};
}

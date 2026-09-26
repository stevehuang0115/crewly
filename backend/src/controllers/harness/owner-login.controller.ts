/**
 * `POST /api/harness/:id/owner-login` — the orchestrator starts a login the
 * owner asked for (the `harness-login` skill).
 *
 * The owner asked the orc, in their own words, to log a harness in or switch
 * its account. The orc must not run `claude setup-token` / `codex login` in
 * its bash tool: that process dies with the tool call, so the code the owner
 * pastes back is stale (2026-09-26). This route hands the request to the
 * re-login coordinator instead — the same forced flow 「重新登录 claude」 in
 * the orc DM starts: the broker keeps the login alive in its own PTY, the
 * owner gets the link in the thread they asked in, their pasted code goes
 * straight into the broker, and success or failure is reported to them by
 * the flow. The orc says nothing more about it.
 *
 * Guards:
 * - Orchestrator only: `X-Agent-Session` must be the orchestrator's session.
 *   Other agents, and callers without the header (the owner uses
 *   `POST /:id/login` from Setup), are refused with 403.
 * - Owner evidence: an owner-authored message from the last
 *   {@link HARNESS_CONSTANTS.OWNER_LOGIN.EVIDENCE_LOOKBACK_MS} must ask for a
 *   login of this harness ({@link isOwnerLoginRequestEvidence}), mirroring
 *   install-skill's owner-approval check. The orc's claim is not trusted.
 *
 * @module controllers/harness/owner-login.controller
 */

import type { Request, Response } from 'express';
import { HARNESS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { getChatV2Service } from '../../services/chat-v2/chat-v2.singleton.js';
import { getHarnessDefinition, resolveHarnessAlias } from '../../services/harness/harness-registry.js';
import {
	getHarnessReloginService,
	type OwnerLoginOptions,
	type OwnerLoginResult,
	type ReloginReplyTarget,
} from '../../services/harness/harness-relogin.service.js';
import type { HarnessId } from '../../services/harness/harness.types.js';
import { isOwnerLoginRequestEvidence } from '../../services/harness/owner-login-request.js';
import { OrcReplyRouteService } from '../../services/orc/orc-reply-route.service.js';
import { getSlackAgentDmService } from '../../services/slack/slack-agent-dm.service.js';
import { resolveOrcTurnReplyTarget } from '../../services/slack/slack-relogin-dm.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

/** What the orc is told after a started login: the flow speaks for itself. */
export const OWNER_LOGIN_NEXT_STARTED =
	'The owner got the login link in Slack (in the thread they asked in). Say nothing more about this login: do not repeat the link, do not claim you sent anything, do not report status. The login flow tells the owner itself when it succeeds or fails.';

/** What the orc is told when Slack is down and no link could be sent. */
export const OWNER_LOGIN_NEXT_NO_SLACK =
	'Slack is not connected, so no link could be sent. Tell the owner in one short line (their language) to finish the login in Crewly Setup → 登录 on the web app, or to run `crewly login <harness>` on the machine.';

/** Injectable dependencies. */
export interface OwnerLoginControllerDeps {
	/** Start the forced owner login (the re-login coordinator) */
	startOwnerLogin: (harnessId: HarnessId, options: OwnerLoginOptions) => OwnerLoginResult;
	/** Owner-authored message texts since a time, newest first (throws when unreadable) */
	recentOwnerMessages: (sinceMs: number) => string[];
	/** Where the orc's current conversation is on Slack (null = the owner's master-bot DM) */
	resolveReplyTarget: () => ReloginReplyTarget | null;
	now?: () => number;
}

/**
 * The backend's dependencies.
 *
 * @returns Deps bound to the coordinator, chat-v2 and the orc's turn origin
 */
export function defaultOwnerLoginDeps(): OwnerLoginControllerDeps {
	return {
		startOwnerLogin: (harnessId, options) => getHarnessReloginService().startOwnerLogin(harnessId, options),
		recentOwnerMessages: (sinceMs) =>
			getChatV2Service().getRecentOwnerMessageContents(sinceMs, HARNESS_CONSTANTS.OWNER_LOGIN.EVIDENCE_MAX_MESSAGES),
		resolveReplyTarget: () =>
			resolveOrcTurnReplyTarget(OrcReplyRouteService.getInstance().getFreshOrigin(ORCHESTRATOR_SESSION_NAME), getSlackAgentDmService()),
	};
}

/**
 * Send a refusal.
 *
 * @param res - Express response
 * @param status - HTTP status
 * @param code - Machine-readable code
 * @param error - Message for the orc
 */
function refuse(res: Response, status: number, code: string, error: string): void {
	res.status(status).json({ success: false, code, error });
}

/**
 * Build the `POST /:id/owner-login` handler.
 *
 * @param getDeps - Dependency accessor (resolved per request; tests inject fakes)
 * @returns Express handler
 *
 * @example
 * ```ts
 * router.post('/:id/owner-login', createOwnerLoginHandler());
 * ```
 */
export function createOwnerLoginHandler(
	getDeps: () => OwnerLoginControllerDeps = defaultOwnerLoginDeps,
): (req: Request, res: Response) => Promise<void> {
	const logger = LoggerService.getInstance().createComponentLogger('HarnessOwnerLogin');
	return async (req, res) => {
		const caller = readAgentSessionHeader(req);
		if (!caller) {
			refuse(res, 403, 'orchestrator_only', 'This route is for the orchestrator\'s harness-login skill. The owner logs in from Setup (POST /api/harness/:id/login).');
			return;
		}
		if (caller !== ORCHESTRATOR_SESSION_NAME) {
			refuse(res, 403, 'orchestrator_only', 'Only the orchestrator can start a harness login for the owner. Ask the orchestrator.');
			return;
		}

		const rawId = typeof req.params.id === 'string' ? req.params.id : '';
		const harnessId = resolveHarnessAlias(rawId);
		const def = harnessId ? getHarnessDefinition(harnessId) : undefined;
		if (!harnessId || !def) {
			refuse(res, 404, 'unknown_harness', `Unknown harness "${rawId}". Use claude, codex or antigravity.`);
			return;
		}

		const deps = getDeps();
		const now = deps.now?.() ?? Date.now();
		let messages: string[];
		try {
			messages = deps.recentOwnerMessages(now - HARNESS_CONSTANTS.OWNER_LOGIN.EVIDENCE_LOOKBACK_MS);
		} catch (error) {
			refuse(
				res,
				503,
				'owner_request_unverifiable',
				`The owner's chat history could not be read (${error instanceof Error ? error.message : String(error)}), so the login request cannot be verified; not starting a login.`,
			);
			return;
		}
		const evidence = messages.find((message) => isOwnerLoginRequestEvidence(message, harnessId));
		if (!evidence) {
			const minutes = Math.round(HARNESS_CONSTANTS.OWNER_LOGIN.EVIDENCE_LOOKBACK_MS / 60_000);
			refuse(
				res,
				403,
				'owner_request_not_found',
				`No owner message in the last ${minutes} min asks to log ${def.displayName} in. Never start a login on your own; if the owner wants one, they will ask.`,
			);
			return;
		}

		const switchAccount = (req.body as { switchAccount?: unknown } | undefined)?.switchAccount === true;
		const result = deps.startOwnerLogin(harnessId, { switchAccount, replyTarget: deps.resolveReplyTarget(), requestedBy: 'orchestrator' });
		if (result.status === 'no_broker_login') {
			res.status(400).json({
				success: false,
				code: 'no_link_login',
				error: result.message,
				next: 'Tell the owner this in one short line, in their language.',
			});
			return;
		}
		logger.info('Orchestrator started an owner-requested login', { harnessId, status: result.status, switchAccount, dmAvailable: result.dmAvailable });
		res.status(202).json({
			success: true,
			data: {
				status: result.status,
				harnessId,
				displayName: def.displayName,
				dmAvailable: result.dmAvailable,
				next: result.dmAvailable ? OWNER_LOGIN_NEXT_STARTED : OWNER_LOGIN_NEXT_NO_SLACK,
			},
		});
	};
}

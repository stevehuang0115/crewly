/**
 * Team pause — boot wiring (specs/2026-10-04-team-pause.md):
 *
 * 1. hydrate the paused-team index from storage (a pause survives restarts);
 * 2. install the pause service and start its auto-resume sweep;
 * 3. register the owner's "pause <team>" / "resume <team>" DM commands
 *    with the Slack bridge (handled here, never by the orc's LLM).
 *
 * Heavy modules are imported lazily so index.ts gains no import cycles.
 *
 * @module services/team/team-pause.wiring
 */

import type { ApiContext } from '../../controllers/types.js';
import { listKnownTeams, syncPausedTeams } from './team-pause.registry.js';
import { createTeamPauseInterceptor } from './team-pause-command.js';
import type { TeamPauseService } from './team-pause.service.js';

/** What index.ts provides. */
export interface TeamPauseWiringInput {
	context: ApiContext;
	logger: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Wire the team pause.
 *
 * @param input - Backend context
 * @returns The running service
 */
export async function startTeamPause(input: TeamPauseWiringInput): Promise<TeamPauseService> {
	syncPausedTeams(await input.context.storageService.getTeams());

	const { SlackReloginDmService } = await import('../slack/slack-relogin-dm.service.js');
	const { getSlackService } = await import('../slack/slack.service.js');
	const { getSlackAgentIdentityService } = await import('../slack/slack-agent-identity.service.js');
	const dm = new SlackReloginDmService(
		() => getSlackService(),
		undefined,
		(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
	);

	const { ensureTeamPauseService } = await import('../../controllers/team/team-pause.controller.js');
	const service = ensureTeamPauseService(input.context, { notifyOwner: (text) => dm.sendToOwner(text) });
	service.start();

	try {
		const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
		getSlackOrchestratorBridge().addInboundInterceptor(
			'the team pause commands',
			createTeamPauseInterceptor({
				ownerDmScope: (m) => dm.ownerDmScope(m),
				replyTargetOf: (m) => dm.replyTargetOf(m),
				reply: (text, target) => dm.sendToOwner(text, target as ReturnType<typeof dm.replyTargetOf>),
				knownTeams: () => listKnownTeams(),
				pause: (teamId, pauseInput) => service.pause(teamId, pauseInput),
				resume: (teamId) => service.resume(teamId),
				onError: (err) => input.logger.warn('Team pause command failed', { error: err instanceof Error ? err.message : String(err) }),
			}),
		);
	} catch (err) {
		input.logger.warn('Team pause Slack commands not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) });
	}
	input.logger.info('Team pause wired');
	return service;
}

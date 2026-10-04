/**
 * Autopilot speed modes — boot wiring (specs/2026-10-04-autopilot-speed-modes.md §5):
 * registers the owner's "set <project> to rush|normal|chill" DM commands
 * with the Slack bridge (handled here, never by the orc's LLM). The
 * interceptor is synchronous, so the project names it matches against are a
 * cache refreshed from storage on a timer.
 *
 * Heavy modules are imported lazily so index.ts gains no import cycles.
 *
 * @module services/project-tickets/autopilot-speed.wiring
 */

import { TICKET_AUTOPILOT_CONSTANTS } from '../../constants.js';
import { resolveTicketAutopilotSettings } from '../../types/ticket-autopilot.types.js';
import type { Project } from '../../types/index.js';
import { createAutopilotSpeedInterceptor } from './autopilot-speed-command.js';
import type { TicketAutopilotService } from './ticket-autopilot.service.js';

/** What index.ts provides. */
export interface AutopilotSpeedWiringInput {
	/** All projects (storage) */
	getProjects: () => Promise<Project[]>;
	/** The running autopilot */
	autopilot: () => TicketAutopilotService;
	logger: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

/** A cache of project ids / names for the synchronous interceptor. */
export class KnownProjectsCache {
	private projects: Array<{ id: string; name: string }> = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * @param load - Reads the projects
	 */
	constructor(private readonly load: () => Promise<Project[]>) {}

	/** The cached projects. */
	list(): Array<{ id: string; name: string }> {
		return this.projects;
	}

	/** Re-read the projects (a failed read keeps the old list). */
	async refresh(): Promise<void> {
		try {
			this.projects = (await this.load()).map((p) => ({ id: p.id, name: p.name }));
		} catch {
			// Keep what we had: a stale list only delays a brand-new project's name.
		}
	}

	/**
	 * Refresh on a timer.
	 *
	 * @param intervalMs - How often
	 */
	start(intervalMs: number): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh(), intervalMs);
		this.timer.unref?.();
	}

	/** Stop the timer. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

/**
 * Wire the speed-mode DM commands.
 *
 * @param input - Projects, the autopilot, a logger
 * @returns The project cache (running)
 */
export async function startAutopilotSpeedCommands(input: AutopilotSpeedWiringInput): Promise<KnownProjectsCache> {
	const cache = new KnownProjectsCache(input.getProjects);
	await cache.refresh();
	cache.start(TICKET_AUTOPILOT_CONSTANTS.SPEED_PROJECT_CACHE_REFRESH_MS);

	const { SlackReloginDmService } = await import('../slack/slack-relogin-dm.service.js');
	const { getSlackService } = await import('../slack/slack.service.js');
	const { getSlackAgentIdentityService } = await import('../slack/slack-agent-identity.service.js');
	const dm = new SlackReloginDmService(
		() => getSlackService(),
		undefined,
		(agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
	);
	try {
		const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
		getSlackOrchestratorBridge().addInboundInterceptor(
			'the autopilot speed commands',
			createAutopilotSpeedInterceptor({
				ownerDmScope: (m) => dm.ownerDmScope(m),
				replyTargetOf: (m) => dm.replyTargetOf(m),
				reply: (text, target) => dm.sendToOwner(text, target as ReturnType<typeof dm.replyTargetOf>),
				knownProjects: () => cache.list(),
				currentMode: async (projectId) =>
					resolveTicketAutopilotSettings((await input.getProjects()).find((p) => p.id === projectId)?.ticketAutopilot).speedMode,
				// The owner's own command: the owner caller (no session).
				setMode: (projectId, mode) => input.autopilot().updateSettings(projectId, { speedMode: mode }, {}),
				onError: (err) => input.logger.warn('Autopilot speed command failed', { error: err instanceof Error ? err.message : String(err) }),
			}),
		);
	} catch (err) {
		input.logger.warn('Autopilot speed Slack commands not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) });
	}
	input.logger.info('Autopilot speed commands wired');
	return cache;
}

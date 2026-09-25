/**
 * Restarts agents after a harness re-login (onboarding Phase 2).
 *
 * A running agent keeps the environment and credentials it was started
 * with, so after Crewly stores a fresh Claude token (exported to agents as
 * `CLAUDE_CODE_OAUTH_TOKEN`) or Codex rewrites its `auth.json`, the stuck
 * agents are restarted. The restart follows the existing
 * heartbeat-monitor / runtime-exit path: stop exit monitoring, kill the PTY,
 * keep the conversation id, `createAgentSession` again — which resumes the
 * conversation (Claude `--resume <id>`, Codex `codex resume <id>`) when
 * auto-resume is on. The orchestrator goes through
 * `OrchestratorRestartService`, which also re-initialises its memory and
 * chat monitoring.
 *
 * @module services/agent/relogin-agent-resumer.service
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { HarnessId } from '../harness/harness.types.js';
import type { ReloginAgentResumer } from '../harness/harness-relogin.service.js';
import type { ISessionBackend } from '../session/session-backend.interface.js';
import type { PersistedSessionInfo } from '../session/session-state-persistence.js';
import type { AgentRegistrationService } from './agent-registration.service.js';

/** The slice of the session-state persistence the resumer uses. */
export interface ResumerPersistence {
	getRegisteredSessionsMap(): Map<string, PersistedSessionInfo>;
	getSessionMetadata(name: string): PersistedSessionInfo | undefined;
	getSessionId(name: string): string | undefined;
	updateSessionId(name: string, sessionId: string): void;
}

/** Injectable dependencies (accessors resolve late: the backend is wired after boot). */
export interface ReloginAgentResumerDeps {
	getBackend: () => Pick<ISessionBackend, 'listSessions' | 'sessionExists' | 'killSession'> | null;
	getPersistence: () => ResumerPersistence;
	getAgentRegistration: () => Pick<AgentRegistrationService, 'createAgentSession'> | null;
	/** Restart the orchestrator (OrchestratorRestartService.attemptRestart) */
	restartOrchestrator: () => Promise<boolean>;
	/** Stop runtime-exit monitoring so the kill is not treated as a crash */
	stopExitMonitoring?: (sessionName: string) => void;
	/** Forget PTY activity of the old session */
	clearActivity?: (sessionName: string) => void;
	logger?: Pick<ComponentLogger, 'info' | 'warn'>;
}

/** Lists and restarts the agents of a harness. */
export class ReloginAgentResumerService implements ReloginAgentResumer {
	private readonly logger: Pick<ComponentLogger, 'info' | 'warn'>;

	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: ReloginAgentResumerDeps) {
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('ReloginAgentResumer');
	}

	/**
	 * Live sessions whose runtime is the harness.
	 *
	 * @param harnessId - Harness (= runtime type)
	 * @returns Session names, orchestrator first
	 */
	listSessions(harnessId: HarnessId): string[] {
		const backend = this.deps.getBackend();
		if (!backend) return [];
		let live: string[];
		try {
			live = backend.listSessions();
		} catch {
			return [];
		}
		const registered = this.deps.getPersistence().getRegisteredSessionsMap();
		const names = live.filter((name) => registered.get(name)?.runtimeType === harnessId);
		return names.sort((a, b) => Number(b === ORCHESTRATOR_SESSION_NAME) - Number(a === ORCHESTRATOR_SESSION_NAME));
	}

	/**
	 * Restart sessions one after another (each resumes its conversation).
	 *
	 * @param sessionNames - Sessions to restart
	 * @returns Resumed and failed session names
	 */
	async resume(sessionNames: readonly string[]): Promise<{ resumed: string[]; failed: string[] }> {
		const resumed: string[] = [];
		const failed: string[] = [];
		for (const name of new Set(sessionNames)) {
			let ok = false;
			try {
				ok = name === ORCHESTRATOR_SESSION_NAME ? await this.deps.restartOrchestrator() : await this.restartAgent(name);
			} catch (error) {
				this.logger.warn('Could not restart agent after re-login', { sessionName: name, error: error instanceof Error ? error.message : String(error) });
			}
			(ok ? resumed : failed).push(name);
		}
		this.logger.info('Agents restarted after re-login', { resumed, failed });
		return { resumed, failed };
	}

	/**
	 * Restart one team agent, keeping its conversation id.
	 *
	 * @param sessionName - Session name
	 * @returns True when the new session was created
	 */
	private async restartAgent(sessionName: string): Promise<boolean> {
		const backend = this.deps.getBackend();
		const registration = this.deps.getAgentRegistration();
		const persistence = this.deps.getPersistence();
		const meta = persistence.getSessionMetadata(sessionName);
		if (!backend || !registration || !meta?.role) {
			this.logger.warn('Cannot restart agent after re-login: missing session metadata or services', { sessionName });
			return false;
		}
		const conversationId = persistence.getSessionId(sessionName);

		this.deps.stopExitMonitoring?.(sessionName);
		if (backend.sessionExists(sessionName)) await backend.killSession(sessionName);
		this.deps.clearActivity?.(sessionName);
		if (conversationId && persistence.getSessionMetadata(sessionName)) {
			persistence.updateSessionId(sessionName, conversationId);
		}

		const result = await registration.createAgentSession({
			sessionName,
			role: meta.role,
			teamId: meta.teamId,
			memberId: meta.memberId,
		});
		if (!result.success) {
			this.logger.warn('createAgentSession failed after re-login', { sessionName, error: result.error });
		}
		return result.success;
	}
}

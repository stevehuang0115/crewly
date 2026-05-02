/**
 * Orchestrator Setup Service
 *
 * Provides a service-level entrypoint for triggering orchestrator setup,
 * mirroring the logic behind `POST /api/orchestrator/setup`. Used by the
 * SlackBridge auto-recovery path so it can reattempt setup without going
 * through HTTP.
 *
 * Design notes:
 * - Dependencies are injected via `setOrchestratorSetupDependencies()` from
 *   the bootstrap layer (`backend/src/index.ts`), keeping this service
 *   decoupled from the API context shape.
 * - Concurrent calls are deduplicated via an in-flight promise — if a
 *   setup is already running, the second caller awaits the same result.
 * - Callers should impose their own timeout on the returned promise; this
 *   service does not enforce a timeout because setup duration varies per
 *   runtime type.
 *
 * @module services/orchestrator/orchestrator-setup.service
 */

import {
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_WINDOW_NAME,
	ORCHESTRATOR_ROLE,
	RUNTIME_TYPES,
	type RuntimeType,
} from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import type { StorageService } from '../core/storage.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { getOrchestratorStatus } from './orchestrator-status.service.js';

/**
 * Minimal contract expected from the agent registration service.
 *
 * Defined as an inline structural type rather than imported to avoid a
 * circular module graph (agent-registration → orchestrator → bridge →
 * agent-registration). Matches `AgentRegistrationService.createAgentSession`.
 */
export interface AgentRegistrationServiceLike {
	createAgentSession(config: {
		sessionName: string;
		role: string;
		projectPath: string;
		windowName: string;
		runtimeType: RuntimeType;
		forceRecreate?: boolean;
		additionalAllowlistPaths?: string[];
	}): Promise<{ success: boolean; sessionName?: string; message?: string; error?: string }>;
}

/**
 * Result of `triggerOrchestratorSetup()`.
 */
export interface OrchestratorSetupResult {
	/** Whether the setup attempt succeeded (or the orchestrator was already healthy). */
	success: boolean;
	/** Session name if setup succeeded. */
	sessionName?: string;
	/** Human-readable status message. */
	message?: string;
	/** Error message if setup failed. */
	error?: string;
	/** True when setup was skipped because the orchestrator was already healthy. */
	skipped?: boolean;
}

/**
 * Injected dependencies wired by the bootstrap layer.
 */
interface SetupDependencies {
	agentRegistrationService: AgentRegistrationServiceLike;
	storageService: StorageService;
}

let dependencies: SetupDependencies | null = null;
let setupInFlight: Promise<OrchestratorSetupResult> | null = null;

const getLogger = (): ComponentLogger =>
	LoggerService.getInstance().createComponentLogger('OrchestratorSetup');

/**
 * Wire the dependencies needed to trigger setup from any caller.
 *
 * Must be called once during bootstrap, after the agent registration service
 * is created. Passing the same dependencies twice is safe (last write wins).
 *
 * @param deps - Required service dependencies
 *
 * @example
 * ```typescript
 * setOrchestratorSetupDependencies({
 *   agentRegistrationService,
 *   storageService,
 * });
 * ```
 */
export function setOrchestratorSetupDependencies(deps: SetupDependencies): void {
	dependencies = deps;
}

/**
 * Reset injected dependencies. Test-only helper.
 *
 * @internal
 */
export function _resetOrchestratorSetupDependenciesForTesting(): void {
	dependencies = null;
	setupInFlight = null;
}

/**
 * Trigger orchestrator setup if it is not already healthy.
 *
 * Steps:
 * 1. Health-check via `getOrchestratorStatus()` — if active, return early.
 * 2. Resolve runtime type from persisted orchestrator status (default: claude-code).
 * 3. Call `createAgentSession()` with `forceRecreate: true`.
 * 4. Initialize memory and start chat monitoring (best-effort).
 *
 * Concurrent callers receive the same in-flight promise — at most one setup
 * runs at a time across the process.
 *
 * The orchestrator's conversation history (`AgentRunner.state.messages`) is
 * left empty after this call. The registration path skips the activation
 * kickoff message for the orchestrator session — this preserves the B1
 * `messageCount === 0` cold-start invariant.
 *
 * @returns Setup result. `skipped: true` if the orchestrator was already healthy.
 *
 * @throws Never — errors are returned in the result object instead.
 */
export async function triggerOrchestratorSetup(): Promise<OrchestratorSetupResult> {
	if (setupInFlight) {
		// Concurrent call — caller waits on the existing setup.
		return setupInFlight;
	}

	if (!dependencies) {
		const error = 'Orchestrator setup dependencies not initialized';
		getLogger().error(error);
		return { success: false, error };
	}

	setupInFlight = _runSetup(dependencies).finally(() => {
		setupInFlight = null;
	});

	return setupInFlight;
}

/**
 * Internal setup runner. Extracted for clarity — `triggerOrchestratorSetup`
 * just guards concurrency.
 */
async function _runSetup(deps: SetupDependencies): Promise<OrchestratorSetupResult> {
	const logger = getLogger();
	try {
		// 1. Skip when already healthy. Avoids hammering setup when SlackBridge's
		// auto-recovery races with another caller.
		try {
			const currentStatus = await getOrchestratorStatus();
			if (currentStatus.isActive) {
				logger.info('Orchestrator is already healthy — skipping setup', {
					agentStatus: currentStatus.agentStatus,
				});
				return {
					success: true,
					skipped: true,
					message: 'Orchestrator is already running (setup skipped)',
					sessionName: ORCHESTRATOR_SESSION_NAME,
				};
			}
		} catch (healthErr) {
			logger.warn('Health check failed, proceeding with setup', {
				error: formatError(healthErr),
			});
		}

		// 2. Resolve runtime type. Falls back to claude-code if unknown.
		let runtimeType: RuntimeType = RUNTIME_TYPES.CLAUDE_CODE as RuntimeType;
		try {
			const orchestratorStatus = await deps.storageService.getOrchestratorStatus();
			const stored = orchestratorStatus?.runtimeType;
			if (stored && Object.values(RUNTIME_TYPES).includes(stored as RuntimeType)) {
				runtimeType = stored as RuntimeType;
			}
		} catch (lookupErr) {
			logger.warn('Failed to read runtime type from storage; defaulting to claude-code', {
				error: formatError(lookupErr),
			});
		}

		// 3. For Gemini CLI we'd normally collect project paths for the
		// allowlist. The auto-recovery path is best-effort and the controller
		// already does this on the explicit setup endpoint, so we keep it
		// simple here. The createAgentSession contract treats the parameter
		// as optional.

		logger.info('Triggering createAgentSession from auto-recovery', {
			sessionName: ORCHESTRATOR_SESSION_NAME,
			runtimeType,
		});

		const result = await deps.agentRegistrationService.createAgentSession({
			sessionName: ORCHESTRATOR_SESSION_NAME,
			role: ORCHESTRATOR_ROLE,
			projectPath: process.cwd(),
			windowName: ORCHESTRATOR_WINDOW_NAME,
			runtimeType,
			forceRecreate: true,
		});

		if (!result.success) {
			logger.error('createAgentSession returned failure', { error: result.error });
			return {
				success: false,
				error: result.error || 'Failed to create orchestrator session',
			};
		}

		// 4. Best-effort memory init + chat monitoring. Failures here do not
		// block setup success — the session is created, these are auxiliary.
		try {
			await MemoryService.getInstance().initializeForSession(
				ORCHESTRATOR_SESSION_NAME,
				ORCHESTRATOR_ROLE,
				process.cwd(),
			);
		} catch (memErr) {
			logger.warn('Memory initialization failed (non-fatal)', {
				error: formatError(memErr),
			});
		}

		try {
			const terminalGateway = getTerminalGateway();
			if (terminalGateway) {
				terminalGateway.startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME);
			}
		} catch (monitorErr) {
			logger.warn('Failed to start chat monitoring (non-fatal)', {
				error: formatError(monitorErr),
			});
		}

		return {
			success: true,
			sessionName: result.sessionName ?? ORCHESTRATOR_SESSION_NAME,
			message: result.message ?? 'Orchestrator session created and registered',
		};
	} catch (error) {
		logger.error('Auto-recovery setup failed', { error: formatError(error) });
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to setup orchestrator session',
		};
	}
}

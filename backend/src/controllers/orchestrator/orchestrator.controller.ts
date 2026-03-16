import { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import { ApiResponse } from '../../types/index.js';
import {
	ORCHESTRATOR_SESSION_NAME,
	ORCHESTRATOR_WINDOW_NAME,
	ORCHESTRATOR_ROLE,
	RUNTIME_TYPES,
	type RuntimeType,
} from '../../constants.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import {
	getOrchestratorStatus as getOrchestratorStatusFromService,
	getOrchestratorOfflineMessage,
} from '../../services/orchestrator/index.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { MemoryService } from '../../services/memory/memory.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('OrchestratorController');

/**
 * In-flight setup promise for deduplication.
 * When a setupOrchestrator call is already in progress, subsequent calls
 * receive the same response instead of triggering concurrent session creation.
 */
let setupInFlightPromise: Promise<{ success: boolean; message?: string; sessionName?: string; error?: string }> | null = null;

/**
 * Reset the in-flight setup state.
 * Exported for testing purposes only.
 */
export function _resetSetupInFlightState(): void {
	setupInFlightPromise = null;
}

// Delegate to existing ApiController methods to preserve complex logic without duplication
export async function getOrchestratorCommands(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const mockCommands = [
			{
				id: '1',
				command: 'get_team_status',
				timestamp: new Date(Date.now() - 300000).toISOString(),
				output: 'All teams active and working',
				status: 'completed',
			},
			{
				id: '2',
				command: 'delegate_task dev-alice "Implement user auth"',
				timestamp: new Date(Date.now() - 600000).toISOString(),
				output: 'Task delegated successfully',
				status: 'completed',
			},
		];
		res.json(mockCommands);
	} catch (error) {
		logger.error('Error fetching orchestrator commands', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json([]);
	}
}

export async function executeOrchestratorCommand(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { command } = req.body as any;
		if (!command || typeof command !== 'string') {
			res.status(400).json({ success: false, error: 'Command is required' });
			return;
		}

		let output = '';
		if (command.startsWith('get_team_status')) {
			const teams = await this.storageService.getTeams();
			const teamStatuses = teams.map((team) => {
				const hasActiveMembers = team.members.some(
					(m) => m.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
				);
				const hasActivatingMembers = team.members.some(
					(m) => m.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING
				);
				const computedStatus = hasActiveMembers
					? CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
					: hasActivatingMembers
					? CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING
					: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
				return {
					name: team.name,
					status: computedStatus,
					members: team.members.length,
					project: (team as any).projectIds?.length ? (team as any).projectIds.join(', ') : 'None',
				};
			});
			output = `Team Status Report:\n${teamStatuses
				.map((t) => `${t.name}: ${t.status} (${t.members} members) - ${t.project}`)
				.join('\n')}`;
		} else if (command.startsWith('list_projects')) {
			const projects = await this.storageService.getProjects();
			output = `Active Projects:\n${projects
				.map(
					(p) =>
						`${p.name}: ${p.status} (${
							Object.values(p.teams).flat().length
						} teams assigned)`
				)
				.join('\n')}`;
		} else if (command.startsWith('list_sessions')) {
			try {
				// Use PTY session backend instead of tmux
				const { getSessionBackendSync } = await import('../../services/session/index.js');
				const sessionBackend = getSessionBackendSync();
				if (sessionBackend) {
					const sessions = sessionBackend.listSessions();
					output = sessions.length > 0
						? `Active terminal sessions:\n${sessions.join('\n')}`
						: 'No active terminal sessions';
				} else {
					output = 'Session backend not initialized';
				}
			} catch (error) {
				output = 'Failed to list terminal sessions';
			}
		} else if (command.startsWith('broadcast')) {
			const message = command.substring(10).trim();
			output = message
				? `Broadcast sent to all active sessions: "${message}"`
				: 'Error: No message provided for broadcast';
		} else if (command.startsWith('help')) {
			output = `Available Orchestrator Commands:
get_team_status - Show status of all teams
list_projects - List all projects and their status
list_sessions - Show active terminal sessions
broadcast <message> - Send message to all team members
delegate_task <team> <task> - Assign task to team
create_team <role> <name> - Create new team
schedule_check <minutes> <message> - Schedule check-in reminder
help - Show this help message`;
		} else {
			output = `Unknown command: ${command}\nType 'help' for available commands.`;
		}

		res.json({ success: true, output, timestamp: new Date().toISOString() });
	} catch (error) {
		logger.error('Error executing orchestrator command', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: 'Failed to execute command',
			output: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
		});
	}
}

export async function sendOrchestratorMessage(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { message } = req.body as any;

		// Use the unified agent message sending
		const result = await this.agentRegistrationService.sendMessageToAgent(
			ORCHESTRATOR_SESSION_NAME,
			message
		);

		if (!result.success) {
			res.status(400).json({
				success: false,
				error: result.error || 'Failed to send message to orchestrator',
			} as ApiResponse);
			return;
		}

		res.json({
			success: true,
			message: 'Message sent to orchestrator successfully',
			messageLength: message.length,
			timestamp: new Date().toISOString(),
		} as ApiResponse);
	} catch (error) {
		logger.error('Error sending orchestrator message', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to send message',
		} as ApiResponse);
	}
}

export async function sendOrchestratorEnter(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		// Use the unified agent key sending
		const result = await this.agentRegistrationService.sendKeyToAgent(
			ORCHESTRATOR_SESSION_NAME,
			'Enter'
		);

		if (!result.success) {
			res.status(500).json({
				success: false,
				error: result.error || 'Failed to send Enter key to orchestrator',
			} as ApiResponse);
			return;
		}

		res.json({
			success: true,
			message: 'Enter key sent to orchestrator',
			timestamp: new Date().toISOString(),
		} as ApiResponse);
	} catch (error) {
		logger.error('Error sending Enter to orchestrator', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to send Enter key',
		} as ApiResponse);
	}
}

/**
 * Setup the orchestrator session with deduplication guard.
 *
 * If a setup is already in progress (from a concurrent request), returns
 * the result of the in-flight setup rather than creating a second session.
 * This prevents the 5-7x concurrent calls observed on page load from
 * each triggering a separate session creation.
 *
 * @param req - Express request object
 * @param res - Express response object
 */
export async function setupOrchestrator(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	logger.info('setupOrchestrator called');

	// Idempotency guard: if setup is already in flight, return its result
	if (setupInFlightPromise) {
		logger.info('setupOrchestrator already in progress, deduplicating concurrent call');
		try {
			const existingResult = await setupInFlightPromise;
			if (existingResult.success) {
				res.json({
					success: true,
					message: existingResult.message || 'Orchestrator setup already in progress (deduplicated)',
					sessionName: existingResult.sessionName,
				} as ApiResponse);
			} else {
				res.status(500).json({
					success: false,
					error: existingResult.error || 'Setup in progress failed',
				} as ApiResponse);
			}
		} catch (error) {
			res.status(500).json({
				success: false,
				error: error instanceof Error ? error.message : 'Setup in progress failed',
			} as ApiResponse);
		}
		return;
	}

	// Create the setup promise and store it for deduplication
	const context = this;
	setupInFlightPromise = _performOrchestratorSetup(context);

	try {
		const result = await setupInFlightPromise;
		if (result.success) {
			res.json({
				success: true,
				message: result.message,
				sessionName: result.sessionName,
			} as ApiResponse);
		} else {
			res.status(500).json({
				success: false,
				error: result.error,
			} as ApiResponse);
		}
	} catch (error) {
		logger.error('Error setting up orchestrator session', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to setup orchestrator session',
		} as ApiResponse);
	} finally {
		setupInFlightPromise = null;
	}
}

/**
 * Core orchestrator setup logic, separated from the HTTP handler
 * for deduplication.
 *
 * @param context - API context with services
 * @returns Setup result object
 */
async function _performOrchestratorSetup(
	context: ApiContext
): Promise<{ success: boolean; message?: string; sessionName?: string; error?: string }> {
	try {
		// Check if the orchestrator is already running and healthy.
		// If so, skip recreation to avoid killing a healthy orchestrator on every page load.
		try {
			const currentStatus = await getOrchestratorStatusFromService();
			if (currentStatus.isActive) {
				logger.info('Orchestrator is already running and healthy, skipping setup', {
					agentStatus: currentStatus.agentStatus,
					message: currentStatus.message,
				});
				return {
					success: true,
					message: 'Orchestrator is already running (setup skipped)',
					sessionName: ORCHESTRATOR_SESSION_NAME,
				};
			}
			logger.info('Orchestrator is not healthy, proceeding with setup', {
				isActive: currentStatus.isActive,
				agentStatus: currentStatus.agentStatus,
			});
		} catch (healthCheckError) {
			logger.warn('Failed to check orchestrator health, proceeding with setup', {
				error: healthCheckError instanceof Error ? healthCheckError.message : String(healthCheckError),
			});
		}

		// Get orchestrator's runtime type from storage
		let runtimeType: string = RUNTIME_TYPES.CLAUDE_CODE; // Default fallback
		try {
			const orchestratorStatus = await context.storageService.getOrchestratorStatus();
			if (orchestratorStatus?.runtimeType) {
				runtimeType = orchestratorStatus.runtimeType;
				logger.info('Using orchestrator runtime type from storage', { runtimeType });
			} else {
				logger.warn('No runtime type found in orchestrator status, using default', { runtimeType });
			}
		} catch (error) {
			logger.warn('Failed to get orchestrator runtime type from storage, using default', { runtimeType, error: error instanceof Error ? error.message : String(error) });
		}

		// For Gemini CLI, gather existing project paths so all /directory add
		// commands can run during postInitialize — before the registration prompt.
		let additionalAllowlistPaths: string[] | undefined;
		if (runtimeType === RUNTIME_TYPES.GEMINI_CLI) {
			try {
				const projects = await context.storageService.getProjects();
				additionalAllowlistPaths = projects.map(project => project.path);
				if (additionalAllowlistPaths.length > 0) {
					logger.info('Will add existing project paths to Gemini CLI allowlist during init', {
						projectPaths: additionalAllowlistPaths,
					});
				}
			} catch (error) {
				logger.warn('Failed to get projects for Gemini CLI allowlist (continuing without)', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		logger.info('Calling agentRegistrationService.createAgentSession', {
			sessionName: ORCHESTRATOR_SESSION_NAME,
			role: ORCHESTRATOR_ROLE,
			runtimeType,
		});

		// Use the unified agent registration service for orchestrator creation
		// forceRecreate: true because this is an explicit user action (Setup button),
		// so skip expensive intelligent recovery and do a clean restart
		const result = await context.agentRegistrationService.createAgentSession({
			sessionName: ORCHESTRATOR_SESSION_NAME,
			role: ORCHESTRATOR_ROLE,
			projectPath: process.cwd(),
			windowName: ORCHESTRATOR_WINDOW_NAME,
			runtimeType: runtimeType as RuntimeType,
			forceRecreate: true,
			additionalAllowlistPaths,
		});

		logger.info('createAgentSession result', {
			success: result.success,
			sessionName: result.sessionName,
			message: result.message,
			error: result.error,
		});

		if (!result.success) {
			logger.error('Failed to create orchestrator session', { error: result.error });
			return {
				success: false,
				error: result.error || 'Failed to create orchestrator session',
			};
		}

		logger.info('Orchestrator session created successfully');

		// Initialize orchestrator memory so remember/recall MCP tools work
		try {
			const memoryService = MemoryService.getInstance();
			await memoryService.initializeForSession(
				ORCHESTRATOR_SESSION_NAME,
				ORCHESTRATOR_ROLE,
				process.cwd()
			);
			logger.info('Orchestrator memory initialized successfully');
		} catch (memoryError) {
			logger.warn('Failed to initialize orchestrator memory', { error: memoryError instanceof Error ? memoryError.message : String(memoryError) });
		}

		// Start persistent chat monitoring for the orchestrator
		// This ensures chat responses are captured even when no terminal panel is open
		const terminalGateway = getTerminalGateway();
		if (terminalGateway) {
			terminalGateway.startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME);
		} else {
			logger.warn('Terminal gateway not available, chat monitoring disabled');
		}

		return {
			success: true,
			message: result.message || 'Orchestrator session created and registered successfully',
			sessionName: result.sessionName,
		};
	} catch (error) {
		logger.error('Error in _performOrchestratorSetup', { error: error instanceof Error ? error.message : String(error) });
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to setup orchestrator session',
		};
	}
}

export async function getOrchestratorHealth(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		// Use the unified agent health checking
		const result = await this.agentRegistrationService.checkAgentHealth(
			ORCHESTRATOR_SESSION_NAME,
			ORCHESTRATOR_ROLE,
			1000
		);

		if (!result.success) {
			res.status(500).json({
				success: false,
				error: result.error || 'Failed to check orchestrator health',
			} as ApiResponse);
			return;
		}

		// Rename 'agent' to 'orchestrator' for backward compatibility
		const responseData = {
			...result.data,
			orchestrator: {
				...result.data!.agent,
				sessionName: result.data!.agent.running ? ORCHESTRATOR_SESSION_NAME : null,
			},
		};
		delete (responseData as any).agent;

		res.json({
			success: true,
			data: responseData,
		} as ApiResponse);
	} catch (error) {
		logger.error('Error checking orchestrator health', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to check orchestrator health',
		} as ApiResponse);
	}
}

export async function stopOrchestrator(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		// Use the unified agent registration service for orchestrator termination
		const result = await this.agentRegistrationService.terminateAgentSession(
			ORCHESTRATOR_SESSION_NAME,
			ORCHESTRATOR_ROLE
		);

		if (!result.success) {
			res.status(500).json({
				success: false,
				error: result.error || 'Failed to stop orchestrator',
			} as ApiResponse);
			return;
		}

		res.json({
			success: true,
			message: result.message || 'Orchestrator stopped successfully',
			sessionName: ORCHESTRATOR_SESSION_NAME,
		} as ApiResponse);
	} catch (error) {
		logger.error('Error stopping orchestrator', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to stop orchestrator',
		} as ApiResponse);
	}
}

export async function assignTaskToOrchestrator(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { projectId } = req.params as any;
		const {
			taskId,
			taskTitle,
			taskDescription,
			taskPriority,
			taskMilestone,
			projectName,
			projectPath,
		} = req.body as any;

		if (!taskId || !taskTitle) {
			res.status(400).json({
				success: false,
				error: 'Task ID and title are required',
			} as ApiResponse);
			return;
		}

		// Use the unified health check to verify orchestrator is running
		const healthResult = await this.agentRegistrationService.checkAgentHealth(
			ORCHESTRATOR_SESSION_NAME,
			ORCHESTRATOR_ROLE
		);

		if (!healthResult.success || !healthResult.data?.agent.running) {
			res.status(400).json({
				success: false,
				error: 'Orchestrator session is not running. Please start the orchestrator first.',
			} as ApiResponse);
			return;
		}

		// Generate the task assignment prompt
		const assignmentMessage =
			await this.promptTemplateService.getOrchestratorTaskAssignmentPrompt({
				projectName,
				projectPath,
				taskId,
				taskTitle,
				taskDescription,
				taskPriority,
				taskMilestone,
			});

		// Use the unified message sending
		const messageResult = await this.agentRegistrationService.sendMessageToAgent(
			ORCHESTRATOR_SESSION_NAME,
			assignmentMessage
		);

		if (!messageResult.success) {
			res.status(500).json({
				success: false,
				error: messageResult.error || 'Failed to send task assignment to orchestrator',
			} as ApiResponse);
			return;
		}

		res.json({
			success: true,
			message: 'Task assigned to orchestrator successfully',
			data: {
				taskId,
				taskTitle,
				sessionName: ORCHESTRATOR_SESSION_NAME,
				assignedAt: new Date().toISOString(),
			},
		} as ApiResponse);
	} catch (error) {
		logger.error('Error assigning task to orchestrator', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to assign task to orchestrator',
		} as ApiResponse);
	}
}

export async function updateOrchestratorRuntime(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const { runtimeType } = req.body as { runtimeType: string };

		if (!runtimeType || typeof runtimeType !== 'string') {
			res.status(400).json({
				success: false,
				error: 'runtimeType is required and must be a string',
			} as ApiResponse);
			return;
		}

		// Validate runtime type
		const validRuntimeTypes: string[] = Object.values(RUNTIME_TYPES);
		if (!validRuntimeTypes.includes(runtimeType)) {
			res.status(400).json({
				success: false,
				error: `Invalid runtime type. Must be one of: ${validRuntimeTypes.join(', ')}`,
			} as ApiResponse);
			return;
		}

		// Update orchestrator runtime type
		await this.storageService.updateOrchestratorRuntimeType(runtimeType as RuntimeType);

		res.json({
			success: true,
			data: { runtimeType },
			message: `Orchestrator runtime updated to ${runtimeType}`,
		} as ApiResponse);
	} catch (error) {
		logger.error('Error updating orchestrator runtime', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to update orchestrator runtime',
		} as ApiResponse);
	}
}

/**
 * Get simple orchestrator status for UI checks.
 *
 * Returns whether the orchestrator is active and a user-friendly message.
 * This is a lightweight endpoint for frontend status checks.
 *
 * @param req - Express request object
 * @param res - Express response object
 */
export async function getOrchestratorStatus(
	this: ApiContext,
	req: Request,
	res: Response
): Promise<void> {
	try {
		const status = await getOrchestratorStatusFromService();

		res.json({
			success: true,
			data: {
				isActive: status.isActive,
				agentStatus: status.agentStatus,
				message: status.message,
				offlineMessage: status.isActive ? null : getOrchestratorOfflineMessage(false),
			},
		} as ApiResponse);
	} catch (error) {
		logger.error('Error getting orchestrator status', { error: error instanceof Error ? error.message : String(error) });
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to get orchestrator status',
		} as ApiResponse);
	}
}

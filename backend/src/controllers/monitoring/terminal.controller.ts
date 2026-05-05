/**
 * Terminal Controller
 *
 * Handles terminal session management endpoints for the API.
 * Uses ISessionBackend for PTY-based session operations.
 *
 * @module terminal-controller
 */

import { Request, Response } from 'express';
import { ApiResponse } from '../../types/index.js';
import { getSessionBackendSync, getSessionBackend } from '../../services/session/index.js';
import { LoggerService, ComponentLogger } from '../../services/core/logger.service.js';
import { TERMINAL_CONTROLLER_CONSTANTS, ORCHESTRATOR_SESSION_NAME, CREWLY_CONSTANTS, RuntimeType, RUNTIME_TYPES } from '../../constants.js';
import {
	validateTerminalInput,
	sanitizeTerminalInput,
	validateSessionName,
} from '../../utils/security.js';
import { StorageService } from '../../services/core/storage.service.js';
import { SubAgentMessageQueue } from '../../services/messaging/sub-agent-message-queue.service.js';
import { AgentSuspendService } from '../../services/agent/agent-suspend.service.js';
import type { ApiContext } from '../types.js';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { PtySessionBackend } from '../../services/session/pty/pty-session-backend.js';
import { InProcessLogBuffer } from '../../services/agent/crewly-agent/in-process-log-buffer.js';
import type { PendingWorkSummary, HeartbeatState } from '../../services/agent/adaptive-heartbeat.service.js';
import { ADAPTIVE_HEARTBEAT_DEFAULTS } from '../../services/agent/adaptive-heartbeat.service.js';

/**
 * Bracketed paste mode markers.
 * Wrapping terminal input in these markers tells TUI applications (Gemini CLI,
 * Codex CLI, etc.) to treat the content as pasted text rather than typed input.
 * This prevents special shell characters like (), $, `, etc. from triggering
 * shell mode or being interpreted as key sequences (#293).
 */
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Wrap a message in bracketed paste mode markers for safe delivery to TUI terminals.
 * This ensures parentheses, quotes, dollar signs, and other shell metacharacters
 * are treated as literal text by the receiving terminal application (#292, #293).
 *
 * @param text - The raw message text
 * @returns The text wrapped in bracketed paste markers
 */
function wrapInBracketedPaste(text: string): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Logger instance for terminal controller */
const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('TerminalController');

/**
 * List all active terminal sessions.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * GET /api/terminal/sessions
 * Response: { success: true, data: { sessions: ["session1", "session2"] } }
 */
export async function listTerminalSessions(req: Request, res: Response): Promise<void> {
	try {
		// Use async getSessionBackend to ensure backend is initialized
		// This prevents race conditions when sessions are queried before orchestrator setup completes
		const backend = await getSessionBackend();

		const ptySessions = backend.listSessions();

		// Include in-process Crewly Agent sessions (AI SDK runtime, no PTY)
		const inProcessBuffer = InProcessLogBuffer.getInstance();
		const inProcessSessionNames = inProcessBuffer.getSessionNames();

		// Merge and deduplicate (in case a session name appears in both)
		const allSessions = [...new Set([...ptySessions, ...inProcessSessionNames])];

		res.json({
			success: true,
			data: {
				sessions: allSessions,
				inProcessSessions: inProcessSessionNames,
			},
		} as ApiResponse);
	} catch (error) {
		logger.error('Error listing terminal sessions', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to list terminal sessions',
		} as ApiResponse);
	}
}

/**
 * Check if a terminal session exists.
 *
 * @param req - Express request object with sessionName param
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * GET /api/terminal/my-session/exists
 * Response: { success: true, data: { exists: true, sessionName: "my-session" } }
 */
export async function sessionExists(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		const exists = backend.sessionExists(sessionName);
		res.json({
			success: true,
			data: { exists, sessionName },
		} as ApiResponse);
	} catch (error) {
		logger.error('Error checking session existence', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to check session existence',
		} as ApiResponse);
	}
}

/**
 * Capture terminal output from a session.
 *
 * @param req - Express request object with sessionName param and lines query
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * GET /api/terminal/my-session/output?lines=50
 * Response: { success: true, data: { output: "...", sessionName: "my-session", lines: 50, truncated: false } }
 */
export async function captureTerminal(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const { lines } = req.query;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		// Limit lines to prevent memory issues
		const requestedLines = parseInt(lines as string) || TERMINAL_CONTROLLER_CONSTANTS.DEFAULT_CAPTURE_LINES;
		const maxLines = Math.min(requestedLines, TERMINAL_CONTROLLER_CONSTANTS.MAX_CAPTURE_LINES);

		// Check if session exists (PTY or in-process)
		const inProcessBuffer = InProcessLogBuffer.getInstance();
		const isPtySession = backend.sessionExists(sessionName);
		const isInProcessSession = !isPtySession && inProcessBuffer.hasSession(sessionName);

		if (!isPtySession && !isInProcessSession) {
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found`,
			} as ApiResponse);
			return;
		}

		// Capture output from PTY session or in-process log buffer
		const output = isPtySession
			? backend.captureOutput(sessionName, maxLines)
			: inProcessBuffer.capture(sessionName, maxLines);

		// Limit output size to prevent memory issues
		const wasTruncated = output.length > TERMINAL_CONTROLLER_CONSTANTS.MAX_OUTPUT_SIZE;
		const trimmedOutput = wasTruncated
			? `[TRUNCATED: output exceeded ${Math.round(output.length / 1024)}KB, showing last ${Math.round(TERMINAL_CONTROLLER_CONSTANTS.MAX_OUTPUT_SIZE / 1024)}KB]\n...` +
				output.substring(output.length - TERMINAL_CONTROLLER_CONSTANTS.MAX_OUTPUT_SIZE + 3)
			: output;

		res.json({
			success: true,
			data: {
				output: trimmedOutput,
				sessionName,
				lines: maxLines,
				truncated: wasTruncated,
			},
		} as ApiResponse);
	} catch (error) {
		logger.error('Error capturing terminal', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to capture terminal output',
		} as ApiResponse);
	}
}

/**
 * Write data to a terminal session.
 *
 * @param req - Express request object with sessionName param and data in body
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * POST /api/terminal/my-session/write
 * Body: { data: "hello\r" }
 * Response: { success: true, message: "Data written successfully" }
 */
export async function writeToSession(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const { data } = req.body;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		// =====================================================================
		// Orc-namespace gate telemetry (4-piece skill-mistake fix piece #4).
		// =====================================================================
		// When an orc-role caller hits this raw /terminal/{session}/write path,
		// emit a warn-log naming the namespace mistake. This is observability —
		// the request still succeeds — so we can catch backsliding from the
		// prompt-builder (piece #2) + soul (piece #3) + skill-frontmatter
		// (piece #1) discipline.
		//
		// Caller is identified via X-Agent-Session header (set canonically by
		// every agent skill that calls api_call() — see config/skills/_common/lib.sh:103).
		// Caller role is resolved via StorageService.findMemberBySessionName.
		// We deliberately skip the log when caller is unknown (registration
		// race, ad-hoc curl) to avoid false positives.
		//
		// Spec provenance: 4-piece skill-mistake fix dispatch piece #4
		// (Sam→Quinn, post-PR #446 merge). PR #449.
		const callerSessionName = req.headers?.['x-agent-session'] as string | undefined;
		if (callerSessionName) {
			try {
				const callerMember = await StorageService.getInstance().findMemberBySessionName(callerSessionName);
				if (callerMember && callerMember.member.role === 'orchestrator') {
					logger.warn(
						'[orc-namespace-gate] orc-role caller wrote to terminal via agent-side /write — should use orc-namespaced wrapper',
						{
							callerSession: callerSessionName,
							targetSession: sessionName,
							skillPath: 'config/skills/agent/core/send-message',
							canonicalAlternative: 'config/skills/orchestrator/send-message',
							endpointHit: '/terminal/{session}/write',
							canonicalEndpoint: '/terminal/{session}/deliver',
							specProvenance: '4-piece skill-mistake fix piece #4 (PR #449)',
						},
					);
				}
			} catch (err) {
				// Lookup failure is non-fatal — telemetry is best-effort, the actual
				// write must proceed. Log at debug so noisy lookup errors don't
				// pollute the warn channel.
				logger.debug('orc-namespace-gate caller lookup failed (non-fatal)', {
					callerSessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (data === undefined || data === null) {
			res.status(400).json({
				success: false,
				error: 'Data is required',
			} as ApiResponse);
			return;
		}

		// Convert data to string and validate for dangerous control sequences
		const dataStr = String(data);
		const validation = validateTerminalInput(dataStr);
		if (!validation.isValid) {
			logger.warn('Terminal input validation failed', {
				sessionName,
				error: validation.error,
				dataLength: dataStr.length,
			});
			res.status(400).json({
				success: false,
				error: `Invalid terminal input: ${validation.error}`,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found`,
			} as ApiResponse);
			return;
		}

		// Check for "message" mode: uses two-step write pattern for TUI
		// runtimes where bracketed paste mode swallows an inline \r.
		// Step 1: Write text only (triggers bracketed paste)
		// Step 2: Delay based on message length (paste processing time)
		// Step 3: Write \r separately (submits the message)
		const mode = req.body.mode as string | undefined;

		if (mode === 'message') {
			// Queue messages for sub-agents that haven't completed initialization.
			// Skip for orchestrator (it has its own queue via QueueProcessorService)
			// and for sessions not tracked as team members (plain shell sessions).
			if (sessionName !== ORCHESTRATOR_SESSION_NAME) {
				try {
					const memberResult = await StorageService.getInstance().findMemberBySessionName(sessionName);
					if (memberResult && memberResult.member.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) {
						SubAgentMessageQueue.getInstance().enqueue(sessionName, dataStr);

						// If agent is suspended, trigger auto-rehydration
						if (memberResult.member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.SUSPENDED) {
							const suspendService = AgentSuspendService.getInstance();
							if (!suspendService.isRehydrating(sessionName)) {
								// Fire-and-forget: rehydration happens in background
								suspendService.rehydrateAgent(sessionName).catch(err => {
									logger.error('Auto-rehydration failed', {
										sessionName,
										error: err instanceof Error ? err.message : String(err),
									});
								});
							}
						}

						logger.info('Message queued until agent is ready', {
							sessionName,
							agentStatus: memberResult.member.agentStatus,
							queueSize: SubAgentMessageQueue.getInstance().getQueueSize(sessionName),
						});
						res.status(202).json({
							success: true,
							queued: true,
							message: 'Message queued until agent is ready',
						} as ApiResponse);
						return;
					}
				} catch (lookupError) {
					// If lookup fails, deliver normally rather than blocking the message
					logger.warn('Agent status lookup failed, delivering message directly', {
						sessionName,
						error: lookupError instanceof Error ? lookupError.message : String(lookupError),
					});
				}
			}

			// Two-step write: text first (wrapped in bracketed paste), then Enter separately.
			// Bracketed paste markers prevent TUI runtimes from interpreting special
			// characters like (), $, ` as shell commands (#293).
			session.write(wrapInBracketedPaste(dataStr));

			// Scale delay based on message length for TUI paste processing
			const enterDelay = Math.min(1000 + Math.ceil(dataStr.length / 10), 5000);
			await new Promise(resolve => setTimeout(resolve, enterDelay));

			// Send Enter as a separate write so it's not consumed by paste mode
			session.write('\r');

			// Backup Enter after a short delay for reliability
			await new Promise(resolve => setTimeout(resolve, 500));
			session.write('\r');
		} else {
			// Default: single write with carriage return appended (for shell commands)
			session.write(dataStr + '\r');
		}

		logger.debug('Data written to session', {
			sessionName,
			dataLength: dataStr.length,
			mode: mode || 'default',
		});

		res.json({
			success: true,
			message: 'Data written successfully',
		} as ApiResponse);
	} catch (error) {
		logger.error('Error writing to session', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to write to session',
		} as ApiResponse);
	}
}

/**
 * Send terminal input to a session (legacy endpoint).
 *
 * @param req - Express request object with sessionName param and input in body
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * POST /api/terminal/my-session/input
 * Body: { input: "echo hello" }
 * Response: { success: true, message: "Input sent successfully" }
 */
export async function sendTerminalInput(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const { input } = req.body;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		if (!input) {
			res.status(400).json({
				success: false,
				error: 'Input is required',
			} as ApiResponse);
			return;
		}

		// Convert input to string and validate for dangerous control sequences
		const inputStr = String(input);
		const validation = validateTerminalInput(inputStr);
		if (!validation.isValid) {
			logger.warn('Terminal input validation failed', {
				sessionName,
				error: validation.error,
				inputLength: inputStr.length,
			});
			res.status(400).json({
				success: false,
				error: `Invalid terminal input: ${validation.error}`,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found`,
			} as ApiResponse);
			return;
		}

		// Write input to session (add carriage return for command execution)
		session.write(inputStr + '\r');

		logger.debug('Input sent to session', {
			sessionName,
			inputLength: inputStr.length,
		});

		res.json({
			success: true,
			message: 'Input sent successfully',
		} as ApiResponse);
	} catch (error) {
		logger.error('Error sending terminal input', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to send terminal input',
		} as ApiResponse);
	}
}

/**
 * Send a special key to a terminal session.
 *
 * @param req - Express request object with sessionName param and key in body
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * POST /api/terminal/my-session/key
 * Body: { key: "Enter" }
 * Response: { success: true, message: "Key sent successfully" }
 */
export async function sendTerminalKey(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const { key } = req.body;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		if (!key) {
			res.status(400).json({
				success: false,
				error: 'Key is required',
			} as ApiResponse);
			return;
		}

		// Validate key name - only allow known safe key names
		const allowedKeys = [
			'Enter', 'Return', 'Escape', 'Tab', 'Backspace', 'Delete',
			'Up', 'Down', 'Right', 'Left', 'Home', 'End', 'PageUp', 'PageDown',
			'C-c', 'C-d', 'C-z', 'C-l'
		];
		if (!allowedKeys.includes(key)) {
			res.status(400).json({
				success: false,
				error: `Invalid key name. Allowed keys: ${allowedKeys.join(', ')}`,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found`,
			} as ApiResponse);
			return;
		}

		// Map key names to their escape sequences
		const keySequence = mapKeyToSequence(key);
		session.write(keySequence);

		logger.debug('Key sent to session', {
			sessionName,
			key,
		});

		res.json({
			success: true,
			message: 'Key sent successfully',
		} as ApiResponse);
	} catch (error) {
		logger.error('Error sending terminal key', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to send terminal key',
		} as ApiResponse);
	}
}

/**
 * Kill a terminal session.
 *
 * @param req - Express request object with sessionName param
 * @param res - Express response object
 * @returns Promise that resolves when response is sent
 *
 * @example
 * DELETE /api/terminal/my-session
 * Response: { success: true, message: "Session killed successfully" }
 */
export async function killSession(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			res.status(503).json({
				success: false,
				error: 'Session backend not initialized',
			} as ApiResponse);
			return;
		}

		if (!backend.sessionExists(sessionName)) {
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found`,
			} as ApiResponse);
			return;
		}

		await backend.killSession(sessionName);

		logger.info('Session killed', { sessionName });

		res.json({
			success: true,
			message: 'Session killed successfully',
		} as ApiResponse);
	} catch (error) {
		logger.error('Error killing session', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to kill session',
		} as ApiResponse);
	}
}

/**
 * Map a key name to its terminal escape sequence.
 *
 * @param key - The key name (e.g., "Enter", "Escape", "C-c")
 * @returns The corresponding escape sequence
 */
function mapKeyToSequence(key: string): string {
	const keyMap: Record<string, string> = {
		Enter: '\r',
		Return: '\r',
		Escape: '\x1b',
		Tab: '\t',
		Backspace: '\x7f',
		Delete: '\x1b[3~',
		Up: '\x1b[A',
		Down: '\x1b[B',
		Right: '\x1b[C',
		Left: '\x1b[D',
		Home: '\x1b[H',
		End: '\x1b[F',
		PageUp: '\x1b[5~',
		PageDown: '\x1b[6~',
		'C-c': '\x03', // Ctrl+C
		'C-d': '\x04', // Ctrl+D
		'C-z': '\x1a', // Ctrl+Z
		'C-l': '\x0c', // Ctrl+L (clear)
	};

	return keyMap[key] ?? key;
}

/**
 * Deliver a message to an agent session with reliable retry and verification.
 *
 * Uses AgentRegistrationService.sendMessageToAgent() — the same battle-tested
 * delivery path that chat-to-orchestrator uses (prompt check + 3-attempt retry
 * + stuck detection). This replaces the fire-and-forget `/write` endpoint for
 * sub-agent message delivery from skill scripts.
 *
 * Must be called with `.call(apiController, req, res)` so `this` is an ApiContext.
 *
 * @param req - Express request with sessionName param and message in body
 * @param res - Express response object
 *
 * @example
 * POST /api/terminal/my-agent/deliver
 * Body: { message: "Hello agent", waitForReady: true }
 * Response: { success: true, verified: true }
 */
export async function deliverMessage(this: ApiContext, req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const { message, runtimeType, waitForReady, waitTimeout, force } = req.body;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		// Validate session name for security
		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		if (!message || typeof message !== 'string') {
			res.status(400).json({
				success: false,
				error: 'Message is required and must be a string',
			} as ApiResponse);
			return;
		}

		// Resolve runtime type: prefer request body, fall back to storage lookup,
		// then check in-process runtimes (crewly-agent has no PTY session)
		let resolvedRuntimeType: RuntimeType | undefined = runtimeType as RuntimeType | undefined;
		if (!resolvedRuntimeType) {
			try {
				const memberResult = await StorageService.getInstance().findMemberBySessionName(sessionName);
				if (memberResult?.member?.runtimeType) {
					resolvedRuntimeType = memberResult.member.runtimeType as RuntimeType;
				}
			} catch {
				// Non-fatal: sendMessageToAgent will use its default
			}
		}
		// Fallback: if still unresolved, check if an in-process crewly-agent exists for this session
		if (!resolvedRuntimeType) {
			const inProcessRuntime = this.agentRegistrationService.getInProcessRuntime(sessionName);
			if (inProcessRuntime) {
				resolvedRuntimeType = RUNTIME_TYPES.CREWLY_AGENT;
			}
		}

		// Check if the session exists locally (PTY or in-process) before attempting delivery.
		// If not found locally, try remote routing via CloudSync before returning 404.
		const localBackend = getSessionBackendSync();
		const inProcessRuntimeCheck = this.agentRegistrationService.getInProcessRuntime(sessionName);
		const hasLocalSession = !!(localBackend?.sessionExists(sessionName)) || !!inProcessRuntimeCheck;

		if (!hasLocalSession) {
			// Session not found locally — attempt remote routing via Cloud
			try {
				const { MessageRouterService } = await import('../../services/messaging/message-router.service.js');
				const router = MessageRouterService.getInstance();
				const routeResult = await router.routeRemote(sessionName, message);
				if (routeResult.routed) {
					logger.info('Message routed to remote device', {
						sessionName,
						deviceId: routeResult.deviceId,
						deviceName: routeResult.deviceName,
						messageLength: message.length,
					});
					res.json({
						success: true,
						remote: true,
						deviceId: routeResult.deviceId,
						deviceName: routeResult.deviceName,
					} as ApiResponse);
					return;
				}
				// Remote routing also failed — fall through to 404
			} catch (routeError) {
				logger.warn('Remote routing attempt failed', {
					sessionName,
					error: routeError instanceof Error ? routeError.message : String(routeError),
				});
			}

			// Neither local nor remote — return 404
			res.status(404).json({
				success: false,
				error: `Session '${sessionName}' not found (local or remote)`,
			} as ApiResponse);
			return;
		}

		// Force mode: write directly to PTY, skipping waitForReady and verification.
		// Use when the agent is busy and waitForReady would time out (#113).
		if (force) {
			// In-process Crewly Agent: route via handleMessage (no PTY)
			if (resolvedRuntimeType === RUNTIME_TYPES.CREWLY_AGENT) {
				const inProcessRuntime = this.agentRegistrationService.getInProcessRuntime(sessionName);
				if (!inProcessRuntime || !inProcessRuntime.isReady()) {
					res.status(404).json({
						success: false,
						error: `In-process agent '${sessionName}' not found or not ready`,
					} as ApiResponse);
					return;
				}
				try {
					await inProcessRuntime.handleMessage(message);
					res.json({ success: true, verified: true, force: true } as ApiResponse);
				} catch (agentErr) {
					res.status(500).json({
						success: false,
						error: `Crewly Agent error: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`,
					} as ApiResponse);
				}
				return;
			}

			const { getSessionBackendSync } = await import('../../services/session/index.js');
			const backend = getSessionBackendSync();
			const session = backend?.getSession(sessionName);
			if (!session) {
				res.status(404).json({
					success: false,
					error: `Session '${sessionName}' not found`,
				} as ApiResponse);
				return;
			}
			// For TUI runtimes (Gemini CLI, Codex CLI), use two-step write:
			// text first (in bracketed paste mode), then Enter separately.
			// Bracketed paste markers prevent TUI runtimes from interpreting
			// special characters like (), $, ` as shell commands (#130, #293).
			const isTuiRuntime = resolvedRuntimeType &&
				resolvedRuntimeType !== RUNTIME_TYPES.CLAUDE_CODE;
			if (isTuiRuntime) {
				session.write(wrapInBracketedPaste(message));
				const enterDelay = Math.min(1000 + Math.ceil(message.length / 10), 5000);
				await new Promise(resolve => setTimeout(resolve, enterDelay));
				session.write('\r');
				await new Promise(resolve => setTimeout(resolve, 500));
				session.write('\r'); // backup Enter
			} else {
				// Claude Code also benefits from two-step write: bundling message+\r
				// in a single write can be swallowed by bracketed paste mode.
				session.write(wrapInBracketedPaste(message));
				const ccEnterDelay = Math.min(1000 + Math.ceil(message.length / 10), 5000);
				await new Promise(resolve => setTimeout(resolve, ccEnterDelay));
				session.write('\r');
				await new Promise(resolve => setTimeout(resolve, 300));
				session.write('\r'); // backup Enter
			}
			logger.info('Message force-delivered via direct PTY write', {
				sessionName,
				messageLength: message.length,
				twoStepWrite: true,
			});
			res.json({
				success: true,
				verified: false,
				force: true,
			} as ApiResponse);
			return;
		}

		// Optionally wait for agent to be at prompt before delivering
		if (waitForReady) {
			const timeout = typeof waitTimeout === 'number' ? waitTimeout : 30000;
			const ready = await this.agentRegistrationService.waitForAgentReady(
				sessionName,
				timeout,
				resolvedRuntimeType
			);
			if (!ready) {
				res.status(408).json({
					success: false,
					error: `Agent '${sessionName}' not ready within ${timeout}ms`,
				} as ApiResponse);
				return;
			}
		}

		// Use the reliable delivery path with retry and verification
		const result = await this.agentRegistrationService.sendMessageToAgent(
			sessionName,
			message,
			resolvedRuntimeType
		);

		if (!result.success) {
			res.status(502).json({
				success: false,
				error: result.error || 'Message delivery failed',
			} as ApiResponse);
			return;
		}

		logger.info('Message delivered via reliable endpoint', {
			sessionName,
			messageLength: message.length,
			runtimeType: resolvedRuntimeType,
		});

		res.json({
			success: true,
			verified: true,
		} as ApiResponse);
	} catch (error) {
		logger.error('Error delivering message', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to deliver message',
		} as ApiResponse);
	}
}

/**
 * Get persistent session log file content.
 *
 * Reads the ANSI-stripped session log file (distinct from live PTY buffer).
 * Includes output from before session restarts.
 *
 * @param req - Express request with sessionName param and optional lines query
 * @param res - Express response object
 *
 * @example
 * GET /api/sessions/crewly-orc/logs?lines=200
 * Response: { success: true, data: { lines: [...], sessionName: "crewly-orc", count: 200 } }
 */
export async function getSessionLogs(req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;
		const lines = parseInt(req.query.lines as string) || 100;

		if (!sessionName) {
			res.status(400).json({
				success: false,
				error: 'Session name is required',
			} as ApiResponse);
			return;
		}

		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({
				success: false,
				error: sessionValidation.error,
			} as ApiResponse);
			return;
		}

		const backend = getSessionBackendSync();
		if (!backend || !(backend instanceof PtySessionBackend)) {
			res.status(503).json({
				success: false,
				error: 'Session backend not available',
			} as ApiResponse);
			return;
		}

		const logPath = backend.getSessionLogPath(sessionName);
		if (!existsSync(logPath)) {
			res.status(404).json({
				success: false,
				error: `No log file found for session '${sessionName}'`,
			} as ApiResponse);
			return;
		}

		const content = await readFile(logPath, 'utf-8');
		const allLines = content.split('\n');
		const lastLines = allLines.slice(-lines);

		res.json({
			success: true,
			data: {
				lines: lastLines,
				sessionName,
				count: lastLines.length,
				totalLines: allLines.length,
			},
		} as ApiResponse);
	} catch (error) {
		logger.error('Error reading session logs', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({
			success: false,
			error: 'Failed to read session logs',
		} as ApiResponse);
	}
}

/**
 * Get pending work for an agent session (#172 Adaptive Heartbeat).
 *
 * Returns pending tasks, undelivered messages, and a recommended
 * heartbeat state so agents can self-schedule their next check-in.
 *
 * @param req - Express request with sessionName param
 * @param res - Express response with PendingWorkSummary
 *
 * @example
 * GET /api/agents/crewly-product-sam/pending-work
 * Response: { success: true, data: { hasPendingWork: true, pendingTasks: [...], ... } }
 */
export async function getPendingWork(this: ApiContext, req: Request, res: Response): Promise<void> {
	try {
		const { sessionName } = req.params;

		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName is required' } as ApiResponse);
			return;
		}

		const sessionValidation = validateSessionName(sessionName);
		if (!sessionValidation.isValid) {
			res.status(400).json({ success: false, error: sessionValidation.error } as ApiResponse);
			return;
		}

		// 1. Get pending tasks from TaskTrackingService
		const tasks = await this.taskTrackingService.getTasksBySessionName(sessionName);
		const pendingTasks = tasks
			.filter(t => t.status === 'assigned' || t.status === 'pending_assignment' || t.status === 'submitted')
			.map(t => ({
				id: t.id,
				taskName: t.taskName,
				priority: t.priority,
				assignedAt: t.assignedAt,
			}));

		// 2. Get pending message count from SubAgentMessageQueue
		const messageQueue = SubAgentMessageQueue.getInstance();
		const pendingMessageCount = messageQueue.getQueueSize(sessionName);
		const pendingMessages: Array<{ id: string; from: string; preview: string; queuedAt: string }> = [];
		// Note: SubAgentMessageQueue doesn't expose individual messages for privacy.
		// We report the count; agents can fetch actual messages via the deliver endpoint.

		// 3. Check if the agent's team is active
		const teams = await this.storageService.getTeams();
		let teamActive = false;
		for (const team of teams) {
			const member = team.members?.find((m: any) => m.sessionName === sessionName);
			if (member) {
				// Team is active if any member besides this one is active
				teamActive = team.members.some((m: any) =>
					m.sessionName !== sessionName && m.agentStatus === 'active'
				);
				break;
			}
		}

		// 4. Determine recommended state
		const hasPendingWork = pendingTasks.length > 0 || pendingMessageCount > 0;
		let recommendedState: HeartbeatState;
		if (hasPendingWork) {
			recommendedState = 'busy';
		} else if (teamActive) {
			recommendedState = 'idle';
		} else {
			recommendedState = 'dormant';
		}

		const recommendedIntervalMs = recommendedState === 'busy'
			? ADAPTIVE_HEARTBEAT_DEFAULTS.busyIntervalMs
			: recommendedState === 'idle'
				? ADAPTIVE_HEARTBEAT_DEFAULTS.idleIntervalMs
				: ADAPTIVE_HEARTBEAT_DEFAULTS.dormantIntervalMs;

		const summary: PendingWorkSummary = {
			hasPendingWork,
			pendingTasks,
			pendingMessages,
			teamActive,
			recommendedState,
			recommendedIntervalMs,
		};

		res.json({ success: true, data: summary } as ApiResponse<PendingWorkSummary>);

	} catch (error) {
		logger.error('Error getting pending work', {
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).json({ success: false, error: 'Failed to get pending work' } as ApiResponse);
	}
}

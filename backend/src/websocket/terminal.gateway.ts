/**
 * Terminal Gateway Module
 *
 * Provides WebSocket-based real-time terminal streaming for PTY and in-process sessions.
 * Uses event-based streaming instead of polling for better performance.
 *
 * In-process sessions (Crewly Agent runtime) are streamed via InProcessLogBuffer
 * EventEmitter events, while PTY sessions use native onData events.
 *
 * @module terminal-gateway
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { TerminalOutput, WebSocketMessage } from '../types/index.js';
import { LoggerService, ComponentLogger } from '../services/core/logger.service.js';
import {
	getSessionBackend,
	getSessionBackendSync,
	type ISessionBackend,
} from '../services/session/index.js';
import { ORCHESTRATOR_SESSION_NAME, TERMINAL_GATEWAY_CONSTANTS } from '../constants.js';
import { InProcessLogBuffer } from '../services/agent/crewly-agent/in-process-log-buffer.js';


/**
 * Terminal Gateway class for WebSocket-based terminal streaming.
 *
 * Provides:
 * - Real-time terminal output streaming via PTY onData events
 * - Terminal input forwarding to PTY sessions
 * - Terminal resize handling
 * - Session subscription management
 */
export class TerminalGateway {
	private io: SocketIOServer;
	private logger: ComponentLogger;

	/** Map of session name to set of subscribed socket IDs */
	private connectedClients: Map<string, Set<string>> = new Map();

	/** Map of session name to unsubscribe function for PTY onData */
	private sessionSubscriptions: Map<string, () => void> = new Map();

	/** Set of sessions with persistent monitoring (not stopped on client disconnect) */
	private persistentMonitoringSessions: Set<string> = new Set();

	/**
	 * Pending retry timers for eager monitoring attempts that fired before the
	 * PTY session was registered in the SessionBackend.
	 *
	 * Keyed by session name. Cleared on first successful attach, on stop, and
	 * on destroy so a backoff schedule never leaks a timer past the gateway.
	 */
	private pendingMonitoringRetries: Map<string, NodeJS.Timeout> = new Map();

	/** Current active chat conversation ID for orchestrator responses */
	private activeConversationId: string | null = null;

	/**
	 * Sessions in read-only mode for security auditing.
	 * Terminal output is streamed normally, but all input is blocked.
	 * Used for compliance auditing and observing agent behavior safely.
	 */
	private readOnlySessions = new Set<string>();

	/**
	 * Set of in-process sessions currently being streamed via InProcessLogBuffer.
	 * These sessions are automatically read-only (no PTY to write to).
	 */
	private inProcessStreamingSessions = new Set<string>();

	/**
	 * Bound handler for InProcessLogBuffer 'data' events.
	 * Stored so it can be removed on destroy.
	 */
	private inProcessDataHandler: ((sessionName: string, formattedLine: string) => void) | null = null;

	/**
	 * Create a new TerminalGateway.
	 *
	 * @param io - Socket.IO server instance
	 */
	constructor(io: SocketIOServer) {
		this.io = io;
		this.logger = LoggerService.getInstance().createComponentLogger('TerminalGateway');

		this.setupEventHandlers();
		this.setupInProcessLogStreaming();
	}

	/**
	 * Set up WebSocket event handlers.
	 */
	private setupEventHandlers(): void {
		this.io.on('connection', (socket: Socket) => {
			this.logger.info('WebSocket client connected', { socketId: socket.id });

			// Handle subscription to terminal sessions
			socket.on('subscribe_to_session', (sessionName: string) => {
				this.logger.debug('Received subscribe_to_session event', {
					sessionName,
					socketId: socket.id,
				});
				this.subscribeToSession(sessionName, socket);
			});

			// Handle unsubscription from terminal sessions
			socket.on('unsubscribe_from_session', (sessionName: string) => {
				this.unsubscribeFromSession(sessionName, socket);
			});

			// Handle sending input to terminal sessions
			socket.on('send_input', async (data: { sessionName: string; input: string }) => {
				await this.sendInput(data.sessionName, data.input, socket);
			});

			// Handle terminal resize events
			socket.on('terminal_resize', (data: { sessionName: string; cols: number; rows: number }) => {
				this.handleTerminalResize(data.sessionName, data.cols, data.rows);
			});

			// Handle request for fresh terminal state (e.g. after resize)
			socket.on('request_terminal_state', (sessionName: string) => {
				this.sendCurrentTerminalState(sessionName, socket);
			});

			// Handle client disconnection
			socket.on('disconnect', () => {
				this.handleClientDisconnect(socket);
			});

			// Send initial connection confirmation
			socket.emit('connected', {
				type: 'connection_established',
				payload: { socketId: socket.id },
				timestamp: new Date().toISOString(),
			} as WebSocketMessage);
		});
	}

	/**
	 * Set up real-time log streaming from InProcessLogBuffer.
	 *
	 * Listens for 'data' events emitted when InProcessLogBuffer.append() is called,
	 * and broadcasts the formatted log line to all WebSocket subscribers of that session.
	 */
	private setupInProcessLogStreaming(): void {
		const logBuffer = InProcessLogBuffer.getInstance();

		this.inProcessDataHandler = (sessionName: string, formattedLine: string) => {
			// Only broadcast if someone is subscribed to this in-process session
			if (!this.inProcessStreamingSessions.has(sessionName)) {
				return;
			}

			const terminalOutput: TerminalOutput = {
				sessionName,
				content: formattedLine + '\r\n',
				timestamp: new Date().toISOString(),
				type: 'stdout',
			};

			const message: WebSocketMessage = {
				type: 'terminal_output',
				payload: terminalOutput,
				timestamp: new Date().toISOString(),
			};

			this.io.to(`terminal_${sessionName}`).emit('terminal_output', message);
		};

		logBuffer.on('data', this.inProcessDataHandler);
		this.logger.info('In-process log streaming listener registered');
	}

	/**
	 * Check if a session is an in-process Crewly Agent session.
	 *
	 * @param sessionName - The session to check
	 * @returns True if the session exists in InProcessLogBuffer
	 */
	isInProcessSession(sessionName: string): boolean {
		return InProcessLogBuffer.getInstance().hasSession(sessionName);
	}

	/**
	 * Subscribe a client to a specific terminal session.
	 *
	 * @param sessionName - The session to subscribe to
	 * @param socket - The client socket
	 */
	subscribeToSession(sessionName: string, socket: Socket): void {
		this.logger.info('Subscribing client to session', {
			socketId: socket.id,
			sessionName,
		});

		// Initialize client set for this session if not exists
		if (!this.connectedClients.has(sessionName)) {
			this.connectedClients.set(sessionName, new Set());
		}

		// Add client to subscription list
		this.connectedClients.get(sessionName)!.add(socket.id);

		// Join socket.io room for this session
		socket.join(`terminal_${sessionName}`);

		// Try PTY streaming first, then fall back to in-process streaming
		let streamingStarted = this.startPtyStreaming(sessionName);

		if (!streamingStarted) {
			// Check if this is an in-process Crewly Agent session
			streamingStarted = this.startInProcessStreaming(sessionName);
		}

		// Send current terminal state to new subscriber
		this.sendCurrentTerminalState(sessionName, socket);

		// Confirm subscription (even if session doesn't exist yet - client will get updates when it's created)
		socket.emit('subscription_confirmed', {
			type: 'subscription_confirmed',
			payload: { sessionName, sessionExists: streamingStarted },
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);

		// If session doesn't exist, also emit a session_not_found so client knows to wait
		if (!streamingStarted) {
			this.logger.info('Session does not exist yet, client will wait for creation', {
				sessionName,
				socketId: socket.id,
			});
			socket.emit('session_pending', {
				type: 'session_pending',
				payload: { sessionName, message: 'Session is being created, please wait...' },
				timestamp: new Date().toISOString(),
			} as WebSocketMessage);
		}
	}

	/**
	 * Start streaming logs from an in-process Crewly Agent session.
	 *
	 * In-process sessions are automatically read-only (no PTY to write to).
	 * Real-time streaming is handled by the InProcessLogBuffer 'data' event
	 * listener set up in setupInProcessLogStreaming().
	 *
	 * @param sessionName - The session to stream from
	 * @returns True if the session is an in-process session and streaming started
	 */
	private startInProcessStreaming(sessionName: string): boolean {
		const logBuffer = InProcessLogBuffer.getInstance();
		if (!logBuffer.hasSession(sessionName)) {
			return false;
		}

		// Mark as in-process streaming session (enables data event broadcasting)
		this.inProcessStreamingSessions.add(sessionName);

		// In-process sessions are always read-only (no PTY to write to)
		this.readOnlySessions.add(sessionName);

		this.logger.info('Started in-process log streaming for session', {
			sessionName,
			isReadOnly: true,
		});
		return true;
	}

	/**
	 * Start streaming output from a PTY session.
	 * Uses event-based onData instead of polling.
	 *
	 * @param sessionName - The session to stream from
	 * @returns True if streaming started successfully, false otherwise
	 */
	private startPtyStreaming(sessionName: string): boolean {
		// Don't duplicate subscriptions
		if (this.sessionSubscriptions.has(sessionName)) {
			this.logger.debug('Session already has streaming subscription', { sessionName });
			return true;
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Session backend not initialized, cannot start streaming', {
				sessionName,
			});
			return false;
		}

		// List all available sessions for debugging
		const availableSessions = backend.listSessions();
		this.logger.debug('Looking for session in backend', {
			sessionName,
			availableSessions,
			sessionCount: availableSessions.length,
		});

		const session = backend.getSession(sessionName);
		if (!session) {
			this.logger.warn('Session not found for streaming', {
				sessionName,
				availableSessions,
			});
			return false;
		}

		// Subscribe to PTY onData events - real-time streaming
		const unsubscribeData = session.onData((data: string) => {
			const terminalOutput: TerminalOutput = {
				sessionName,
				content: data,
				timestamp: new Date().toISOString(),
				type: 'stdout',
			};

			this.broadcastOutput(sessionName, terminalOutput);
		});

		// Subscribe to exit events
		const unsubscribeExit = session.onExit((exitCode: number) => {
			const lastOutput = backend.captureOutput(sessionName, 50);
			this.logger.info('Session exited', {
				sessionName,
				exitCode,
				lastOutput: lastOutput?.slice(-500),
			});
			this.broadcastSessionStatus(sessionName, 'terminated');
			this.cleanupSessionSubscription(sessionName);
		});

		// Store combined cleanup function to prevent memory leaks
		this.sessionSubscriptions.set(sessionName, () => {
			unsubscribeData();
			unsubscribeExit();
		});
		this.logger.info('Started PTY streaming for session', { sessionName });
		return true;
	}

	/**
	 * Stop streaming output from a PTY session.
	 * Does not stop sessions with persistent monitoring enabled.
	 *
	 * @param sessionName - The session to stop streaming from
	 * @param force - Force stop even for persistent monitoring sessions
	 */
	private stopPtyStreaming(sessionName: string, force: boolean = false): void {
		// Don't stop persistent monitoring sessions unless forced
		if (!force && this.persistentMonitoringSessions.has(sessionName)) {
			this.logger.debug('Skipping stop for persistent monitoring session', { sessionName });
			return;
		}

		const unsubscribe = this.sessionSubscriptions.get(sessionName);
		if (unsubscribe) {
			unsubscribe();
			this.sessionSubscriptions.delete(sessionName);
			this.persistentMonitoringSessions.delete(sessionName);
			this.logger.info('Stopped PTY streaming for session', { sessionName });
		}
	}

	/**
	 * Start persistent monitoring for the orchestrator session.
	 *
	 * Ensures chat responses are captured even when no WebSocket clients are
	 * viewing the terminal. If the PTY session is not yet registered in the
	 * SessionBackend (e.g. eager call from boot fires before
	 * createAgentSession's backend registration completes), schedules bounded
	 * retries on the {@link TERMINAL_GATEWAY_CONSTANTS.MONITORING_RETRY_BACKOFFS_MS}
	 * backoff schedule. Persistent flag stays set across retries so a parallel
	 * subscriber path doesn't bypass eventual attachment.
	 *
	 * @param sessionName - The orchestrator session name to monitor
	 * @returns True if monitoring started synchronously on first attempt; false
	 *          if a retry was scheduled (caller-visible failure is reserved for
	 *          terminal failure after all retries, surfaced via ERROR log only).
	 */
	startOrchestratorChatMonitoring(sessionName: string): boolean {
		this.logger.info('Starting persistent orchestrator chat monitoring', { sessionName });

		// Cancel any in-flight retry from a previous start call so we don't
		// stack two backoff schedules on the same session.
		this.clearPendingMonitoringRetry(sessionName);

		// Force cleanup any stale subscription from a previous session.
		// When the orchestrator is restarted, the old PTY session is destroyed but
		// the subscription entry may still exist pointing to the dead session.
		// We must remove it so startPtyStreaming creates a fresh subscription.
		if (this.sessionSubscriptions.has(sessionName)) {
			this.logger.info('Cleaning up existing subscription for orchestrator chat monitoring', { sessionName });
			const unsubscribe = this.sessionSubscriptions.get(sessionName)!;
			unsubscribe();
			this.sessionSubscriptions.delete(sessionName);
		}

		// Mark session as persistent so it won't be stopped when clients disconnect
		this.persistentMonitoringSessions.add(sessionName);

		const started = this.startPtyStreaming(sessionName);
		if (started) {
			return true;
		}

		// Backend hasn't registered the session yet (race with createAgentSession).
		// Keep persistentMonitoringSessions flagged and schedule bounded retries.
		this.logger.warn(
			'PTY not ready for orchestrator chat monitoring, scheduling retries',
			{ sessionName, schedule: TERMINAL_GATEWAY_CONSTANTS.MONITORING_RETRY_BACKOFFS_MS },
		);
		this.scheduleMonitoringRetry(sessionName, 0);
		return false;
	}

	/**
	 * Schedule the next bounded retry attempt to attach orchestrator monitoring.
	 *
	 * @param sessionName - Session name being monitored
	 * @param attemptIndex - 0-based index into MONITORING_RETRY_BACKOFFS_MS
	 */
	private scheduleMonitoringRetry(sessionName: string, attemptIndex: number): void {
		const schedule = TERMINAL_GATEWAY_CONSTANTS.MONITORING_RETRY_BACKOFFS_MS;

		if (attemptIndex >= schedule.length) {
			// Exhausted retries — log diagnostics and give up. Drop the
			// persistent flag so a subsequent subscriber-driven attach can
			// still proceed via the normal subscribeToSession path.
			const backend = getSessionBackendSync();
			this.logger.error(
				'Orchestrator chat monitoring failed after all retries — orc output will not stream until a client subscribes',
				{
					sessionName,
					attempts: schedule.length,
					availableSessions: backend?.listSessions() ?? [],
				},
			);
			this.persistentMonitoringSessions.delete(sessionName);
			this.pendingMonitoringRetries.delete(sessionName);
			return;
		}

		const delayMs = schedule[attemptIndex];
		const timer = setTimeout(() => {
			this.pendingMonitoringRetries.delete(sessionName);

			// Stop guard: the persistent flag is cleared by
			// stopOrchestratorChatMonitoring. If it's gone, abandon retry.
			if (!this.persistentMonitoringSessions.has(sessionName)) {
				this.logger.debug('Monitoring retry abandoned — persistent flag cleared', {
					sessionName,
					attemptIndex,
				});
				return;
			}

			const started = this.startPtyStreaming(sessionName);
			if (started) {
				this.logger.info('Orchestrator chat monitoring attached on retry', {
					sessionName,
					attemptIndex: attemptIndex + 1,
					delayMs,
				});
				return;
			}

			this.scheduleMonitoringRetry(sessionName, attemptIndex + 1);
		}, delayMs);

		// Allow the process to exit even if a retry is still pending.
		// Without unref, lingering timers keep node alive past graceful shutdown.
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
		this.pendingMonitoringRetries.set(sessionName, timer);
	}

	/**
	 * Clear any pending monitoring retry timer for a session.
	 *
	 * Idempotent — safe to call when no retry is queued.
	 *
	 * @param sessionName - Session name whose retry should be cleared
	 */
	private clearPendingMonitoringRetry(sessionName: string): void {
		const timer = this.pendingMonitoringRetries.get(sessionName);
		if (timer) {
			clearTimeout(timer);
			this.pendingMonitoringRetries.delete(sessionName);
		}
	}

	/**
	 * Stop persistent monitoring for the orchestrator session.
	 *
	 * Cancels any in-flight retry schedule so a stop mid-backoff doesn't leak
	 * a timer that later attaches to a session the caller already gave up on.
	 *
	 * @param sessionName - The orchestrator session name
	 */
	stopOrchestratorChatMonitoring(sessionName: string): void {
		this.logger.info('Stopping persistent orchestrator chat monitoring', { sessionName });
		this.clearPendingMonitoringRetry(sessionName);
		this.stopPtyStreaming(sessionName, true);
	}

	/**
	 * Clean up session subscription when session ends.
	 *
	 * @param sessionName - The session to clean up
	 */
	private cleanupSessionSubscription(sessionName: string): void {
		this.stopPtyStreaming(sessionName);
		this.connectedClients.delete(sessionName);
	}

	/**
	 * Unsubscribe a client from a terminal session.
	 *
	 * @param sessionName - The session to unsubscribe from
	 * @param socket - The client socket
	 */
	unsubscribeFromSession(sessionName: string, socket: Socket): void {
		const clients = this.connectedClients.get(sessionName);
		if (clients) {
			clients.delete(socket.id);

			// Stop streaming if no more clients watching
			if (clients.size === 0) {
				this.stopPtyStreaming(sessionName);
				// Clean up in-process streaming tracking
				this.inProcessStreamingSessions.delete(sessionName);
				this.connectedClients.delete(sessionName);
			}
		}

		// Leave socket.io room
		socket.leave(`terminal_${sessionName}`);

		this.logger.debug('Client unsubscribed from session', {
			socketId: socket.id,
			sessionName,
		});

		// Confirm unsubscription
		socket.emit('unsubscription_confirmed', {
			type: 'unsubscription_confirmed',
			payload: { sessionName },
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);
	}

	/**
	 * Send input to a terminal session.
	 *
	 * @param sessionName - The session to send input to
	 * @param input - The input string
	 * @param socket - The client socket
	 */
	async sendInput(sessionName: string, input: string, socket: Socket): Promise<void> {
		try {
			// Block input for read-only sessions (audit mode)
			if (this.readOnlySessions.has(sessionName)) {
				this.logger.warn('Input blocked for read-only session', { sessionName, fromClient: socket.id });
				socket.emit('error', {
					type: 'read_only',
					payload: { sessionName, error: 'Session is in read-only mode (audit mode). Input is blocked.' },
					timestamp: new Date().toISOString(),
				} as WebSocketMessage);
				return;
			}

			const backend = getSessionBackendSync();
			if (!backend) {
				throw new Error('Session backend not initialized');
			}

			const session = backend.getSession(sessionName);
			if (!session) {
				socket.emit('error', {
					type: 'session_not_found',
					payload: { sessionName, error: 'Session does not exist' },
					timestamp: new Date().toISOString(),
				} as WebSocketMessage);
				return;
			}

			// Write input directly to PTY
			session.write(input);

			this.logger.debug('Sent input to session', {
				sessionName,
				inputLength: input.length,
				fromClient: socket.id,
			});

			// Broadcast input confirmation to all subscribers
			this.broadcastMessage(sessionName, 'input_received', {
				sessionName,
				input,
				fromClient: socket.id,
			});
		} catch (error) {
			this.logger.error('Error sending input to session', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});

			socket.emit('error', {
				type: 'input_error',
				payload: {
					sessionName,
					error: error instanceof Error ? error.message : 'Failed to send input',
				},
				timestamp: new Date().toISOString(),
			} as WebSocketMessage);
		}
	}

	/**
	 * Handle terminal resize events.
	 *
	 * @param sessionName - The session to resize
	 * @param cols - New column count
	 * @param rows - New row count
	 */
	private handleTerminalResize(sessionName: string, cols: number, rows: number): void {
		try {
			const backend = getSessionBackendSync();
			if (!backend) {
				this.logger.warn('Cannot resize: session backend not initialized');
				return;
			}

			// Use resizeSession if available (resizes both PTY and headless buffer).
			// This prevents cursor movement corruption when the frontend xterm.js
			// has different dimensions than the backend headless terminal buffer.
			if (backend.resizeSession) {
				backend.resizeSession(sessionName, cols, rows);
			} else {
				const session = backend.getSession(sessionName);
				if (!session) {
					this.logger.debug('Cannot resize: session not found', { sessionName });
					return;
				}
				session.resize(cols, rows);
			}

			this.logger.debug('Terminal resized', { sessionName, cols, rows });

			// Broadcast resize event to other clients viewing the same session
			this.broadcastMessage(sessionName, 'terminal_resized', {
				sessionName,
				cols,
				rows,
			});
		} catch (error) {
			this.logger.error('Error resizing terminal', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Handle client disconnection.
	 *
	 * @param socket - The disconnected client socket
	 */
	private handleClientDisconnect(socket: Socket): void {
		this.logger.info('Client disconnected', { socketId: socket.id });

		// Remove client from all session subscriptions
		for (const [sessionName, clients] of this.connectedClients.entries()) {
			if (clients.has(socket.id)) {
				clients.delete(socket.id);

				// Stop streaming if no more clients watching
				if (clients.size === 0) {
					this.stopPtyStreaming(sessionName);
					this.inProcessStreamingSessions.delete(sessionName);
					this.connectedClients.delete(sessionName);
				}
			}
		}
	}

	/**
	 * Broadcast terminal output to all subscribers of a session.
	 * Also processes orchestrator output for chat responses.
	 *
	 * @param sessionName - The session name
	 * @param output - The terminal output
	 */
	private broadcastOutput(sessionName: string, output: TerminalOutput): void {
		const message: WebSocketMessage = {
			type: 'terminal_output',
			payload: output,
			timestamp: new Date().toISOString(),
		};

		this.io.to(`terminal_${sessionName}`).emit('terminal_output', message);
	}

	/**
	 * Enable read-only mode for a session. Output streaming continues but
	 * all input is blocked. Used for security auditing and safe observation.
	 *
	 * @param sessionName - The session to set as read-only
	 */
	setReadOnly(sessionName: string): void {
		this.readOnlySessions.add(sessionName);
		this.logger.info('Session set to read-only mode', { sessionName });
	}

	/**
	 * Disable read-only mode for a session, restoring normal input capability.
	 *
	 * @param sessionName - The session to restore
	 */
	clearReadOnly(sessionName: string): void {
		this.readOnlySessions.delete(sessionName);
		this.logger.info('Session read-only mode cleared', { sessionName });
	}

	/**
	 * Check if a session is in read-only (audit) mode.
	 *
	 * @param sessionName - The session to check
	 * @returns True if the session is read-only
	 */
	isReadOnly(sessionName: string): boolean {
		return this.readOnlySessions.has(sessionName);
	}

	/**
	 * Set the active conversation ID for orchestrator chat responses.
	 *
	 * @param conversationId - The conversation ID to set
	 */
	setActiveConversationId(conversationId: string | null): void {
		this.activeConversationId = conversationId;
	}

	/**
	 * Get the active conversation ID.
	 *
	 * @returns The active conversation ID or null
	 */
	getActiveConversationId(): string | null {
		return this.activeConversationId;
	}

	/**
	 * Broadcast session status changes.
	 *
	 * @param sessionName - The session name
	 * @param status - The status string
	 */
	private broadcastSessionStatus(sessionName: string, status: string): void {
		const message: WebSocketMessage = {
			type: 'team_status',
			payload: { sessionName, status },
			timestamp: new Date().toISOString(),
		};

		this.io.to(`terminal_${sessionName}`).emit('session_status', message);
	}

	/**
	 * Broadcast general messages to session subscribers.
	 *
	 * @param sessionName - The session name
	 * @param type - Message type
	 * @param payload - Message payload
	 */
	private broadcastMessage(sessionName: string, type: string, payload: unknown): void {
		const message: WebSocketMessage = {
			type: type as WebSocketMessage['type'],
			payload,
			timestamp: new Date().toISOString(),
		};

		this.io.to(`terminal_${sessionName}`).emit(type, message);
	}

	/**
	 * Send current terminal state to a new subscriber.
	 *
	 * @param sessionName - The session name
	 * @param socket - The client socket
	 */
	private async sendCurrentTerminalState(sessionName: string, socket: Socket): Promise<void> {
		try {
			this.logger.debug('Sending current terminal state', {
				sessionName,
				socketId: socket.id,
			});

			// Check in-process sessions first (they don't have a PTY backend)
			if (this.inProcessStreamingSessions.has(sessionName)) {
				const logBuffer = InProcessLogBuffer.getInstance();
				const output = logBuffer.capture(sessionName, 500);

				const terminalState: TerminalOutput = {
					sessionName,
					content: output + '\r\n',
					timestamp: new Date().toISOString(),
					type: 'stdout',
				};

				this.logger.debug('Emitting initial in-process terminal state', {
					sessionName,
					contentLength: output.length,
				});

				socket.emit('initial_terminal_state', {
					type: 'initial_terminal_state',
					payload: terminalState,
					timestamp: new Date().toISOString(),
				} as WebSocketMessage);
				return;
			}

			const backend = getSessionBackendSync();
			if (!backend) {
				socket.emit('error', {
					type: 'terminal_state_error',
					payload: { sessionName, error: 'Session backend not initialized' },
					timestamp: new Date().toISOString(),
				} as WebSocketMessage);
				return;
			}

			if (!backend.sessionExists(sessionName)) {
				this.logger.debug('Session does not exist', { sessionName });
				socket.emit('session_not_found', {
					type: 'session_not_found',
					payload: { sessionName },
					timestamp: new Date().toISOString(),
				} as WebSocketMessage);
				return;
			}

			// Get serialized terminal visual state (plain text, no cursor movements).
			// The headless terminal processes all ANSI sequences and returns the
			// rendered result — safe for replay at any terminal dimensions.
			// Falls back to raw history if serialization is not available.
			const output = backend.getSerializedState
				? await backend.getSerializedState(sessionName)
				: backend.getRawHistory(sessionName);

			const terminalState: TerminalOutput = {
				sessionName,
				content: output,
				timestamp: new Date().toISOString(),
				type: 'stdout',
			};

			this.logger.debug('Emitting initial terminal state', {
				sessionName,
				contentLength: output.length,
			});

			// Send initial terminal state
			socket.emit('initial_terminal_state', {
				type: 'initial_terminal_state',
				payload: terminalState,
				timestamp: new Date().toISOString(),
			} as WebSocketMessage);
		} catch (error) {
			this.logger.error('Error getting terminal state', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});

			socket.emit('error', {
				type: 'terminal_state_error',
				payload: {
					sessionName,
					error: error instanceof Error ? error.message : 'Failed to get terminal state',
				},
				timestamp: new Date().toISOString(),
			} as WebSocketMessage);
		}
	}

	/**
	 * Get statistics about connected clients.
	 *
	 * @returns Connection statistics
	 */
	getConnectionStats(): {
		totalClients: number;
		sessionSubscriptions: Record<string, number>;
		totalSessions: number;
		activeStreams: number;
	} {
		const sessionSubscriptions: Record<string, number> = {};

		for (const [sessionName, clients] of this.connectedClients.entries()) {
			sessionSubscriptions[sessionName] = clients.size;
		}

		return {
			totalClients: this.io.sockets.sockets.size,
			sessionSubscriptions,
			totalSessions: this.connectedClients.size,
			activeStreams: this.sessionSubscriptions.size,
		};
	}

	/**
	 * Force disconnect all clients from a session.
	 *
	 * @param sessionName - The session name
	 */
	disconnectSessionClients(sessionName: string): void {
		this.io.to(`terminal_${sessionName}`).disconnectSockets();
		this.cleanupSessionSubscription(sessionName);

		this.logger.info('Disconnected all clients from session', { sessionName });
	}

	/**
	 * Broadcast system-wide notifications.
	 *
	 * @param message - Notification message
	 * @param type - Notification type
	 */
	broadcastSystemNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
		this.io.emit('system_notification', {
			type: 'system_notification',
			payload: { message, notificationType: type },
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);
	}

	/**
	 * Broadcast orchestrator status changes.
	 *
	 * @param orchestratorData - Orchestrator data
	 */
	broadcastOrchestratorStatus(orchestratorData: unknown): void {
		this.io.emit('orchestrator_status_changed', {
			type: 'orchestrator_status_changed',
			payload: orchestratorData,
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);
	}

	/**
	 * Broadcast team member status changes.
	 *
	 * @param memberData - Team member data
	 */
	broadcastTeamMemberStatus(memberData: unknown): void {
		this.io.emit('team_member_status_changed', {
			type: 'team_member_status_changed',
			payload: memberData,
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);
	}

	/**
	 * Broadcast a system resource alert to all connected clients.
	 *
	 * @param alertData - Alert details including key, message, severity, and timestamp
	 */
	broadcastSystemResourceAlert(alertData: {
		alertKey: string;
		message: string;
		severity: string;
		timestamp: string;
	}): void {
		this.io.emit('system_resource_alert', {
			type: 'system_resource_alert',
			payload: alertData,
			timestamp: alertData.timestamp,
		});
	}

	/**
	 * Broadcast context window status updates to all connected clients.
	 *
	 * @param contextData - Context window status data
	 */
	broadcastContextWindowStatus(contextData: {
		sessionName: string;
		memberId?: string;
		teamId?: string;
		contextPercent: number;
		level: string;
		timestamp: string;
	}): void {
		this.io.emit('context_window_status', {
			type: 'context_window_status',
			payload: contextData,
			timestamp: contextData.timestamp,
		});
	}

	/**
	 * Broadcast comprehensive team activity updates.
	 *
	 * @param activityData - Activity data
	 */
	broadcastTeamActivity(activityData: unknown): void {
		this.io.emit('team_activity_updated', {
			type: 'team_activity_updated',
			payload: activityData,
			timestamp: new Date().toISOString(),
		} as WebSocketMessage);
	}

	/**
	 * Destroy the gateway and clean up all subscriptions.
	 */
	destroy(): void {
		// Cancel any pending monitoring retries before tearing down.
		// Otherwise a queued retry could fire after destroy and attach
		// a listener to a session whose owner has gone away.
		for (const timer of this.pendingMonitoringRetries.values()) {
			clearTimeout(timer);
		}
		this.pendingMonitoringRetries.clear();

		// Unsubscribe from all PTY sessions
		for (const unsubscribe of this.sessionSubscriptions.values()) {
			unsubscribe();
		}
		this.sessionSubscriptions.clear();
		this.connectedClients.clear();
		this.persistentMonitoringSessions.clear();

		// Clean up in-process log streaming
		if (this.inProcessDataHandler) {
			InProcessLogBuffer.getInstance().removeListener('data', this.inProcessDataHandler);
			this.inProcessDataHandler = null;
		}
		this.inProcessStreamingSessions.clear();

		this.logger.info('TerminalGateway destroyed');
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

let terminalGatewayInstance: TerminalGateway | null = null;

/**
 * Set the terminal gateway singleton instance.
 * Called during server initialization.
 *
 * @param gateway - The TerminalGateway instance
 */
export function setTerminalGateway(gateway: TerminalGateway): void {
	terminalGatewayInstance = gateway;
}

/**
 * Get the terminal gateway singleton instance.
 *
 * @returns The TerminalGateway instance or null if not initialized
 */
export function getTerminalGateway(): TerminalGateway | null {
	return terminalGatewayInstance;
}

/**
 * Reset the terminal gateway singleton instance (for testing).
 */
export function resetTerminalGateway(): void {
	terminalGatewayInstance = null;
}

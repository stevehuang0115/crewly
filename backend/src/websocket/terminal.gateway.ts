/**
 * Terminal Gateway Module
 *
 * Provides WebSocket-based real-time terminal streaming for PTY sessions.
 * Uses event-based streaming instead of polling for better performance.
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
import { getChatGateway } from './chat.gateway.js';
import { ORCHESTRATOR_SESSION_NAME, NOTIFY_CONSTANTS, SLACK_NOTIFY_CONSTANTS } from '../constants.js';
import { getSlackOrchestratorBridge } from '../services/slack/slack-orchestrator-bridge.js';
import { getChatService } from '../services/chat/chat.service.js';
import type { SlackNotification } from '../types/slack.types.js';
import { stripAnsiCodes, generateResponseHash, ResponseDeduplicator } from '../utils/terminal-output.utils.js';
import { extractConversationId, extractMarkerBlocks, extractChatResponseBlocks } from '../utils/terminal-string-ops.js';
import { parseNotifyContent, type NotifyPayload } from '../types/chat.types.js';


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

	/** Current active chat conversation ID for orchestrator responses */
	private activeConversationId: string | null = null;

	/** Buffer to accumulate orchestrator output for [NOTIFY] / legacy marker detection */
	private orchestratorOutputBuffer: string = '';

	/** Maximum buffer size to prevent memory issues (100KB) */
	private readonly MAX_BUFFER_SIZE = 100 * 1024;

	/** Deduplicator for recently sent chat responses */
	private responseDeduplicator = new ResponseDeduplicator();

	/**
	 * Create a new TerminalGateway.
	 *
	 * @param io - Socket.IO server instance
	 */
	constructor(io: SocketIOServer) {
		this.io = io;
		this.logger = LoggerService.getInstance().createComponentLogger('TerminalGateway');

		this.setupEventHandlers();
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

		// Start PTY output streaming if not already started
		const streamingStarted = this.startPtyStreaming(sessionName);

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
			this.logger.info('Session exited', { sessionName, exitCode });
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
	 * This ensures chat responses are captured even when no WebSocket clients are viewing the terminal.
	 *
	 * @param sessionName - The orchestrator session name to monitor
	 * @returns True if monitoring started successfully
	 */
	startOrchestratorChatMonitoring(sessionName: string): boolean {
		this.logger.info('Starting persistent orchestrator chat monitoring', { sessionName });

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

		// Clear the output buffer and response hash cache for fresh monitoring
		this.orchestratorOutputBuffer = '';
		this.responseDeduplicator.clear();

		// Mark session as persistent so it won't be stopped when clients disconnect
		this.persistentMonitoringSessions.add(sessionName);

		const started = this.startPtyStreaming(sessionName);
		if (!started) {
			this.logger.warn('Failed to start orchestrator chat monitoring', { sessionName });
			this.persistentMonitoringSessions.delete(sessionName);
		}
		return started;
	}

	/**
	 * Stop persistent monitoring for the orchestrator session.
	 *
	 * @param sessionName - The orchestrator session name
	 */
	stopOrchestratorChatMonitoring(sessionName: string): void {
		this.logger.info('Stopping persistent orchestrator chat monitoring', { sessionName });
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

			const session = backend.getSession(sessionName);
			if (!session) {
				this.logger.debug('Cannot resize: session not found', { sessionName });
				return;
			}

			session.resize(cols, rows);

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

		// Process orchestrator output for chat responses
		if (sessionName === ORCHESTRATOR_SESSION_NAME) {
			this.processOrchestratorOutputForChat(sessionName, output.content);
		}
	}

	/**
	 * Process orchestrator terminal output for [NOTIFY], legacy [CHAT_RESPONSE],
	 * and legacy [SLACK_NOTIFY] markers.
	 *
	 * Buffers output, then runs the unified [NOTIFY] handler first, followed by
	 * legacy handlers for backward compatibility with orchestrators that haven't
	 * restarted yet.
	 *
	 * @param sessionName - The orchestrator session name
	 * @param content - The terminal output content
	 */
	private processOrchestratorOutputForChat(sessionName: string, content: string): void {
		const chatGateway = getChatGateway();
		if (!chatGateway) {
			this.logger.debug('Chat gateway not available for response processing');
			return;
		}

		const cleanContent = stripAnsiCodes(content);

		// Extract conversation ID from the output if present
		// The format is [CHAT:conversationId] at the start of a response
		const extractedConvId = extractConversationId(cleanContent);
		if (extractedConvId) {
			this.logger.debug('Extracted conversation ID from output', { conversationId: extractedConvId });
			this.activeConversationId = extractedConvId;
		}

		// Always buffer content — notifications don't require a conversation ID
		this.orchestratorOutputBuffer += cleanContent;

		// Prevent buffer from growing too large
		if (this.orchestratorOutputBuffer.length > this.MAX_BUFFER_SIZE) {
			this.orchestratorOutputBuffer = this.orchestratorOutputBuffer.slice(-this.MAX_BUFFER_SIZE / 2);
		}

		// Process unified [NOTIFY] markers first (preferred format)
		this.processNotifyMarkers(sessionName);

		// Process legacy [CHAT_RESPONSE] markers for backward compatibility
		this.processLegacyChatResponse(sessionName);

		// Process legacy [SLACK_NOTIFY] markers for backward compatibility
		this.processLegacySlackNotifications();

		this.trimBufferIfNoOpenMarkers();
	}

	/**
	 * Build a SlackNotification from a NotifyPayload.
	 *
	 * @param payload - Parsed notify payload
	 * @returns SlackNotification with defaults applied
	 */
	private buildSlackNotification(payload: NotifyPayload): SlackNotification {
		return {
			type: (payload.type || 'alert') as SlackNotification['type'],
			title: payload.title || payload.type || 'Notification',
			message: payload.message,
			urgency: payload.urgency || 'normal',
			timestamp: new Date().toISOString(),
			channelId: payload.channelId,
			threadTs: payload.threadTs,
		};
	}

	/**
	 * Send a notification to the Slack bridge with error handling.
	 *
	 * @param notification - The Slack notification to send
	 * @param context - Description of the call site for logging
	 */
	private sendToSlackBridge(notification: SlackNotification, context: string): void {
		const bridge = getSlackOrchestratorBridge();
		if (bridge.isInitialized()) {
			this.logger.info(`Routing ${context} to Slack`, {
				type: notification.type,
				channelId: notification.channelId,
			});
			bridge.sendNotification(notification).catch((error) => {
				this.logger.warn(`Failed to route ${context} to Slack`, {
					error: error instanceof Error ? error.message : String(error),
					type: notification.type,
				});
			});
		} else {
			this.logger.warn(`Slack bridge not initialized, skipping ${context}`, {
				type: notification.type,
			});
		}
	}

	/**
	 * Process unified [NOTIFY]...[/NOTIFY] markers from the orchestrator output buffer.
	 *
	 * Parses header+body (or legacy JSON) payload via `parseNotifyContent()` and
	 * routes to chat, Slack, or both based on which fields are present:
	 * - `conversationId` present → route to chat UI
	 * - `channelId` present → route to Slack
	 * - Both → both (common case)
	 * - Neither + activeConversationId exists → fallback to chat
	 * - `type` alone (no channelId) → chat only (type is metadata, not a routing signal)
	 *
	 * @param sessionName - The orchestrator session name
	 */
	/**
	 * Process unified [NOTIFY]...[/NOTIFY] markers from the orchestrator output buffer.
	 *
	 * Filters out false positives from Claude Code tool output display.
	 * When Claude Code reads files (e.g., prompt.md) or runs bash commands,
	 * the displayed output may contain [NOTIFY] example blocks. These are
	 * detected by checking for the ⏺ tool indicator in the text preceding
	 * each match — real NOTIFY blocks are direct AI output (no tool indicator).
	 *
	 * @param sessionName - The orchestrator session name
	 */
	private processNotifyMarkers(sessionName: string): void {
		if (!this.orchestratorOutputBuffer.includes(NOTIFY_CONSTANTS.OPEN_TAG)) {
			return;
		}

		const blocks = extractMarkerBlocks(
			this.orchestratorOutputBuffer,
			NOTIFY_CONSTANTS.OPEN_TAG,
			NOTIFY_CONSTANTS.CLOSE_TAG
		);

		let lastMatchEnd = 0;
		let inToolOutput = false;

		for (const block of blocks) {
			// Check if this NOTIFY block is inside Claude Code tool output.
			// Tool output is preceded by ⏺ (U+23FA). Look at the text between
			// the previous match end and this match start for state transitions:
			// - ⏺ with no following ❯ → entering/still in tool output
			// - ❯ after ⏺ → tool output ended, back to direct AI output
			const gapText = this.orchestratorOutputBuffer.slice(lastMatchEnd, block.startIndex);
			if (gapText.includes('⏺')) {
				inToolOutput = true;
			}
			if (gapText.includes('❯')) {
				inToolOutput = false;
			}
			if (inToolOutput) {
				this.logger.debug('Skipping NOTIFY inside tool output (false positive)', {
					matchStart: block.startIndex,
					gapSnippet: gapText.slice(-80),
				});
				lastMatchEnd = block.endIndex;
				continue;
			}

			const rawContent = block.content;
			lastMatchEnd = block.endIndex;

			const payload = parseNotifyContent(rawContent);
			if (!payload) {
				this.logger.warn('Invalid or empty NOTIFY payload', {
					rawContent: rawContent.slice(0, 200),
				});
				continue;
			}

			this.logger.debug('Detected NOTIFY marker in orchestrator output', {
				contentLength: payload.message.length,
			});

			// Fire-and-forget to keep PTY non-blocking
			void this.handleNotifyPayload(sessionName, payload).catch(error => {
				this.logger.warn('Error handling NOTIFY payload', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}

		// Remove processed NOTIFY blocks from buffer
		if (lastMatchEnd > 0) {
			this.orchestratorOutputBuffer = this.orchestratorOutputBuffer.slice(lastMatchEnd);
		}
	}


	/**
	 * Handle a single parsed NOTIFY payload — route to chat and/or Slack.
	 *
	 * When a channelId is present, Slack delivery metadata is stored on the chat
	 * message with `slackDeliveryStatus: 'pending'`. On successful Slack delivery,
	 * the status is updated to `'delivered'`. On failure, the error and attempt count
	 * are recorded, and the reconciliation service will retry later.
	 *
	 * @param sessionName - The orchestrator session name
	 * @param payload - Parsed NOTIFY payload
	 */
	private async handleNotifyPayload(sessionName: string, payload: NotifyPayload): Promise<void> {
		const canFallbackToActiveConversation = !payload.conversationId
			&& !payload.channelId
			&& !payload.threadTs
			&& !payload.type;
		const conversationId = payload.conversationId
			|| (canFallbackToActiveConversation ? this.activeConversationId : null);

		// Build metadata dict with NOTIFY fields for the chat message
		const metadata: Record<string, unknown> = {};
		if (payload.channelId) {
			metadata.slackChannelId = payload.channelId;
			metadata.slackDeliveryStatus = 'pending';
			metadata.slackDeliveryAttempts = 0;
			if (payload.threadTs) metadata.slackThreadTs = payload.threadTs;
		}
		if (payload.type) metadata.notifyType = payload.type;
		if (payload.title) metadata.notifyTitle = payload.title;
		if (payload.urgency) metadata.notifyUrgency = payload.urgency;

		// Route to chat UI
		let chatMessage: import('../types/chat.types.js').ChatMessage | null = null;
		if (conversationId) {
			const responseHash = generateResponseHash(conversationId, payload.message);
			if (!this.responseDeduplicator.isDuplicate(responseHash)) {
				this.logger.info('Routing NOTIFY to chat', {
					conversationId,
					contentLength: payload.message.length,
				});

				const chatGateway = getChatGateway();
				if (chatGateway) {
					chatMessage = await chatGateway.processNotifyMessage(
						sessionName,
						payload.message,
						conversationId,
						Object.keys(metadata).length > 0 ? metadata : undefined
					);
				}
			} else {
				this.logger.debug('Skipping duplicate NOTIFY chat message', {
					conversationId,
					contentLength: payload.message.length,
				});
			}
		}
		if (!conversationId && payload.type) {
			this.logger.debug('Dropping non-conversation NOTIFY payload to avoid cross-thread event leakage', {
				type: payload.type,
				hasChannelId: Boolean(payload.channelId),
			});
		}

		// Slack delivery is handled exclusively by the reply-slack skill
		// (which calls /api/slack/send directly). Do NOT route NOTIFY payloads
		// to Slack here — PTY re-renders cause duplicate detections with partial
		// content, and the timing is unreliable (NOTIFY fires before the skill).
		// NOTIFY is only for routing responses to the chat UI above.
		if (payload.channelId) {
			this.logger.debug('NOTIFY has channelId but Slack delivery is skill-handled, skipping', {
				channelId: payload.channelId,
				type: payload.type,
			});

			// Track that this channel+thread was handled by skill so the
			// SlackBridge's sendSlackResponse fallback can skip its duplicate send.
			const bridge = getSlackOrchestratorBridge();
			if (bridge.isInitialized()) {
				bridge.markDeliveredBySkill(payload.channelId, payload.threadTs);
			}

			// Mark delivery status on the chat message
			if (chatMessage && conversationId) {
				const chatService = getChatService();
				await chatService.updateMessageMetadata(conversationId, chatMessage.id, {
					slackDeliveryStatus: 'delivered_by_skill',
					slackDeliveryAttemptedAt: new Date().toISOString(),
				});
			}
		}
	}

	/**
	 * Trim the orchestrator output buffer if there are no pending open markers.
	 * Prevents unbounded growth when output doesn't contain any markers.
	 */
	private trimBufferIfNoOpenMarkers(): void {
		const hasPendingMarker =
			this.orchestratorOutputBuffer.includes(NOTIFY_CONSTANTS.OPEN_TAG) ||
			this.orchestratorOutputBuffer.includes('[CHAT_RESPONSE') ||
			this.orchestratorOutputBuffer.includes(SLACK_NOTIFY_CONSTANTS.OPEN_TAG);
		if (!hasPendingMarker) {
			// Keep a small trailing buffer in case the tag is split across chunks
			const lastNewline = this.orchestratorOutputBuffer.lastIndexOf('\n');
			if (lastNewline > 1000) {
				this.orchestratorOutputBuffer = this.orchestratorOutputBuffer.slice(lastNewline);
			}
		}
	}

	/**
	 * Process legacy [CHAT_RESPONSE]...[/CHAT_RESPONSE] markers from the buffer.
	 * @deprecated Use [NOTIFY] markers instead. Kept for backward compatibility.
	 *
	 * @param sessionName - The orchestrator session name
	 */
	private processLegacyChatResponse(sessionName: string): void {
		if (!this.activeConversationId) {
			return;
		}

		if (!this.orchestratorOutputBuffer.includes('[CHAT_RESPONSE')) {
			return;
		}

		this.logger.debug('Processing legacy [CHAT_RESPONSE] markers (deprecated — use [NOTIFY])');

		const chatGateway = getChatGateway();
		if (!chatGateway) {
			return;
		}

		const blocks = extractChatResponseBlocks(this.orchestratorOutputBuffer);
		let lastMatchEnd = 0;

		for (const block of blocks) {
			const embeddedConversationId = block.conversationId;
			const responseContent = block.content;
			lastMatchEnd = block.endIndex;

			const conversationId = embeddedConversationId || this.activeConversationId;

			if (!conversationId) {
				continue;
			}

			const responseHash = generateResponseHash(conversationId, responseContent);
			if (this.responseDeduplicator.isDuplicate(responseHash)) {
				this.logger.debug('Skipping duplicate legacy chat response', {
					conversationId,
					contentLength: responseContent.length,
				});
				continue;
			}

			this.logger.info('Extracted legacy chat response from orchestrator output', {
				contentLength: responseContent.length,
				conversationId,
				embeddedConversationId,
			});

			chatGateway.processTerminalOutput(
				sessionName,
				`[CHAT_RESPONSE]${responseContent}[/CHAT_RESPONSE]`,
				conversationId
			).catch(error => {
				this.logger.warn('Failed to process legacy chat response', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}

		if (lastMatchEnd > 0) {
			this.orchestratorOutputBuffer = this.orchestratorOutputBuffer.slice(lastMatchEnd);
		}
	}

	/**
	 * Process legacy [SLACK_NOTIFY]...[/SLACK_NOTIFY] markers from the buffer.
	 * @deprecated Use [NOTIFY] markers instead. Kept for backward compatibility.
	 */
	private processLegacySlackNotifications(): void {
		if (!this.orchestratorOutputBuffer.includes(SLACK_NOTIFY_CONSTANTS.OPEN_TAG)) {
			return;
		}

		this.logger.debug('Processing legacy [SLACK_NOTIFY] markers (deprecated — use [NOTIFY])');

		const blocks = extractMarkerBlocks(
			this.orchestratorOutputBuffer,
			SLACK_NOTIFY_CONSTANTS.OPEN_TAG,
			SLACK_NOTIFY_CONSTANTS.CLOSE_TAG
		);
		let lastMatchEnd = 0;

		for (const block of blocks) {
			const rawContent = block.content;
			lastMatchEnd = block.endIndex;

			// Legacy SLACK_NOTIFY is always JSON — use parseNotifyContent which
			// auto-detects JSON and applies PTY cleanup
			const payload = parseNotifyContent(rawContent);
			if (!payload) {
				this.logger.warn('Invalid legacy SLACK_NOTIFY payload', {
					rawContent: rawContent.slice(0, 200),
				});
				continue;
			}

			// Legacy format required `type` — skip if missing
			if (!payload.type) {
				this.logger.warn('Invalid legacy SLACK_NOTIFY payload: missing type', {
					rawContent: rawContent.slice(0, 200),
				});
				continue;
			}

			this.logger.info('Detected legacy SLACK_NOTIFY marker in orchestrator output', {
				contentLength: payload.message.length,
			});

			const fullNotification = this.buildSlackNotification(payload);
			this.sendToSlackBridge(fullNotification, 'legacy SLACK_NOTIFY');
		}

		if (lastMatchEnd > 0) {
			this.orchestratorOutputBuffer = this.orchestratorOutputBuffer.slice(lastMatchEnd);
		}
	}

	/**
	 * Clear the orchestrator output buffer.
	 * Called when conversation changes or on cleanup.
	 */
	clearOrchestratorBuffer(): void {
		this.orchestratorOutputBuffer = '';
		this.responseDeduplicator.clear();
	}

	/**
	 * Set the active conversation ID for orchestrator chat responses.
	 * Clears the output buffer when conversation changes.
	 *
	 * @param conversationId - The conversation ID to set
	 */
	setActiveConversationId(conversationId: string | null): void {
		// Clear buffer when conversation changes
		if (conversationId !== this.activeConversationId) {
			this.clearOrchestratorBuffer();
		}
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
	private sendCurrentTerminalState(sessionName: string, socket: Socket): void {
		try {
			this.logger.debug('Sending current terminal state', {
				sessionName,
				socketId: socket.id,
			});

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

			// Get raw output history with ANSI codes preserved for color rendering
			const output = backend.getRawHistory(sessionName);

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
		// Unsubscribe from all PTY sessions
		for (const unsubscribe of this.sessionSubscriptions.values()) {
			unsubscribe();
		}
		this.sessionSubscriptions.clear();
		this.connectedClients.clear();
		this.persistentMonitoringSessions.clear();

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

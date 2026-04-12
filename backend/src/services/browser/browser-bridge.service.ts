/**
 * Crewly in Chrome — Browser Bridge Service
 *
 * Provides a raw WebSocket server that the Crewly in Chrome extension connects to.
 * Acts as a bridge between REST API calls (from remote-browser skill) and the
 * Chrome Extension. When a REST endpoint receives a command, it forwards it to
 * the connected Chrome Extension via WebSocket and waits for the response.
 *
 * Architecture:
 *   remote-browser skill ─HTTP→ /api/browser/* ─WS→ Chrome Extension
 *   Chrome Extension ─WS→ BrowserBridgeService ─HTTP response→ remote-browser skill
 *
 * @module services/browser/browser-bridge.service
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { BROWSER_BRIDGE_CONSTANTS } from '../../constants.js';

/** Represents a connected Chrome Extension client */
export interface BrowserClient {
	/** Unique client identifier */
	id: string;
	/** WebSocket connection */
	ws: WebSocket;
	/** Timestamp when connected */
	connectedAt: Date;
	/** User-agent header from the connection */
	userAgent?: string;
}

/** Pending command waiting for a response from the Chrome Extension */
interface PendingCommand {
	/** Resolve the promise with the response */
	resolve: (value: BrowserCommandResponse) => void;
	/** Reject the promise on timeout/error */
	reject: (reason: Error) => void;
	/** Timer for command timeout */
	timer: ReturnType<typeof setTimeout>;
}

/** Command sent to Chrome Extension via WebSocket */
export interface BrowserCommand {
	/** Unique command ID for request-response correlation */
	id: string;
	/** Tool name the Chrome Extension should execute */
	tool: string;
	/** Parameters for the tool */
	params?: Record<string, unknown>;
	/** Name of the agent sending this command (displayed in extension banner) */
	agentName?: string;
}

/** Response from Chrome Extension */
export interface BrowserCommandResponse {
	/** Command ID matching the request */
	id: string;
	/** Whether the command succeeded */
	success: boolean;
	/** Result data on success */
	result?: unknown;
	/** Error message on failure */
	error?: string;
}

/** Status information about the Crewly in Chrome bridge */
export interface BrowserBridgeStatus {
	/** Whether a Chrome Extension is reachable (direct WS or Cloud relay) */
	connected: boolean;
	/** Number of directly connected Chrome Extension clients via WebSocket */
	clientCount: number;
	/** WebSocket server path */
	wsPath: string;
	/** Whether the Cloud relay path to an Extension is available */
	relayAvailable?: boolean;
	/** Cloud device ID of the relay-connected Extension (null if not discovered) */
	relayDeviceId?: string | null;
}

/**
 * BrowserBridgeService manages WebSocket connections from the Crewly Chrome
 * Extension and provides a command-response bridge for the REST API layer.
 *
 * Singleton pattern ensures a single WebSocket server per backend instance.
 */
export class BrowserBridgeService {
	private static instance: BrowserBridgeService | null = null;
	private readonly logger: ComponentLogger;
	private wss: WebSocketServer | null = null;
	private clients: Map<string, BrowserClient> = new Map();
	private pendingCommands: Map<string, PendingCommand> = new Map();
	private commandCounter = 0;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('BrowserBridge');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns BrowserBridgeService instance
	 */
	static getInstance(): BrowserBridgeService {
		if (!BrowserBridgeService.instance) {
			BrowserBridgeService.instance = new BrowserBridgeService();
		}
		return BrowserBridgeService.instance;
	}

	/**
	 * Reset singleton instance (for testing).
	 */
	static resetInstance(): void {
		BrowserBridgeService.instance = null;
	}

	/**
	 * Attach the WebSocket server to an existing HTTP server.
	 * Uses noServer mode to avoid conflicting with Socket.IO's upgrade handler.
	 * When two WebSocketServer instances both use `server: httpServer`, they both
	 * register 'upgrade' event handlers. The ws library sends a 400 Bad Request
	 * for non-matching paths, which corrupts the Socket.IO WebSocket connection
	 * (the raw "HTTP/1.1 400" bytes appear as an invalid frame with RSV1 set).
	 *
	 * @param httpServer - The HTTP server to attach to
	 */
	attach(httpServer: HttpServer): void {
		if (this.wss) {
			this.logger.warn('WebSocket server already attached');
			return;
		}

		this.wss = new WebSocketServer({
			noServer: true,
			perMessageDeflate: false,
		});

		// Intercept 'upgrade' events for /ws/browser BEFORE Socket.IO sees them.
		// Problem: Node EventEmitter has no stopPropagation — all 'upgrade' listeners
		// fire for every request. Socket.IO's Engine.IO handler interferes with
		// browser-bridge WebSocket connections (corrupts frames, sets RSV1 compression
		// bits), causing "Invalid frame header" / "RSV1 must be clear" in the Extension.
		// Fix: Override httpServer.emit to exclusively handle our path and skip all
		// other listeners (including Engine.IO) for /ws/browser upgrades.
		const originalEmit = httpServer.emit.bind(httpServer) as (...args: unknown[]) => boolean;
		(httpServer as { emit: (...args: unknown[]) => boolean }).emit = (event: unknown, ...args: unknown[]): boolean => {
			if (event === 'upgrade') {
				const request = args[0] as { url?: string; headers: Record<string, string | undefined> };
				const url = request.url || '';
				const host = request.headers.host || 'localhost';
				const pathname = new URL(url, `http://${host}`).pathname;
				if (pathname === BROWSER_BRIDGE_CONSTANTS.WS_PATH) {
					// Handle exclusively — no other upgrade listeners will fire
					this.wss!.handleUpgrade(
						args[0] as Parameters<InstanceType<typeof WebSocketServer>['handleUpgrade']>[0],
						args[1] as Parameters<InstanceType<typeof WebSocketServer>['handleUpgrade']>[1],
						args[2] as Parameters<InstanceType<typeof WebSocketServer>['handleUpgrade']>[2],
						(ws) => { this.wss!.emit('connection', ws, args[0]); },
					);
					return true;
				}
			}
			return originalEmit(event, ...args);
		};

		this.wss.on('connection', (ws, req) => {
			const clientId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const userAgent = req.headers['user-agent'];

			const client: BrowserClient = {
				id: clientId,
				ws,
				connectedAt: new Date(),
				userAgent,
			};

			this.clients.set(clientId, client);
			this.logger.info('Chrome Extension connected', {
				clientId,
				clientCount: this.clients.size,
			});

			ws.on('message', (data) => {
				this.handleMessage(clientId, data);
			});

			ws.on('close', (code, reason) => {
				this.clients.delete(clientId);
				this.logger.info('Chrome Extension disconnected', {
					clientId,
					code,
					reason: reason.toString(),
					clientCount: this.clients.size,
				});
			});

			ws.on('error', (err) => {
				this.logger.error('Chrome Extension WebSocket error', {
					clientId,
					error: err.message,
				});
			});

			// Send a welcome/pong to confirm connection
			ws.send(JSON.stringify({ type: 'pong' }));
		});

		this.wss.on('error', (err) => {
			this.logger.error('WebSocket server error', { error: err.message });
		});

		this.logger.info('Crewly in Chrome WebSocket server attached', {
			path: BROWSER_BRIDGE_CONSTANTS.WS_PATH,
		});
	}

	/**
	 * Handle incoming WebSocket message from a Chrome Extension client.
	 * Messages are either heartbeat pings or command responses.
	 *
	 * @param clientId - ID of the client that sent the message
	 * @param data - Raw WebSocket message data
	 */
	private handleMessage(clientId: string, data: unknown): void {
		try {
			const msg = JSON.parse(String(data));

			// Handle heartbeat ping
			if (msg.type === 'ping') {
				const client = this.clients.get(clientId);
				if (client && client.ws.readyState === WebSocket.OPEN) {
					client.ws.send(JSON.stringify({ type: 'pong' }));
				}
				return;
			}

			// Handle command response (has 'id' field)
			if (msg.id && this.pendingCommands.has(msg.id)) {
				const pending = this.pendingCommands.get(msg.id)!;
				clearTimeout(pending.timer);
				this.pendingCommands.delete(msg.id);
				pending.resolve(msg as BrowserCommandResponse);
				return;
			}

			this.logger.debug('Unhandled message from Chrome Extension', { clientId, msg });
		} catch (err) {
			this.logger.warn('Failed to parse Chrome Extension message', {
				clientId,
				error: (err as Error).message,
			});
		}
	}

	/**
	 * Send a command to the Chrome Extension and wait for the response.
	 * Commands are sent to the first connected client.
	 *
	 * @param tool - Tool name to execute (e.g., 'navigate', 'screenshot')
	 * @param params - Tool parameters
	 * @param timeoutMs - Command timeout in milliseconds
	 * @param agentName - Optional agent name to display in the extension banner
	 * @returns Response from the Chrome Extension
	 * @throws Error if no client is connected or command times out
	 */
	async sendCommand(
		tool: string,
		params?: Record<string, unknown>,
		timeoutMs: number = BROWSER_BRIDGE_CONSTANTS.COMMAND_TIMEOUT_MS,
		agentName?: string
	): Promise<BrowserCommandResponse> {
		const client = this.getActiveClient();

		// Fallback to Cloud relay if no direct WS client connected
		if (!client) {
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const relayAdapter = BrowserRelayAdapter.getInstance();
			if (relayAdapter.isAvailable()) {
				this.logger.info('No direct WS client, routing via Cloud relay', { tool });
				return relayAdapter.sendViaRelay(tool, params, timeoutMs, agentName);
			}
			throw new Error('No Chrome Extension connected (direct WS or Cloud relay)');
		}

		const id = `cmd-${++this.commandCounter}-${Date.now()}`;
		const command: BrowserCommand = { id, tool, params };
		if (agentName) {
			command.agentName = agentName;
		}

		return new Promise<BrowserCommandResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(id);
				reject(new Error(`Command '${tool}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pendingCommands.set(id, { resolve, reject, timer });

			try {
				client.ws.send(JSON.stringify(command));
			} catch (err) {
				clearTimeout(timer);
				this.pendingCommands.delete(id);
				reject(new Error(`Failed to send command: ${(err as Error).message}`));
			}
		});
	}

	/**
	 * Get the current bridge status, including relay availability.
	 *
	 * @returns Status information with direct WS and relay details
	 */
	getStatus(): BrowserBridgeStatus {
		const directConnected = this.clients.size > 0;
		let relayAvailable = false;
		let relayDeviceId: string | null = null;

		try {
			// Dynamic import avoided — use synchronous check
			const { BrowserRelayAdapter } = require('./browser-relay-adapter.service.js');
			const adapter = BrowserRelayAdapter.getInstance() as {
				isAvailable: () => boolean;
				getExtensionDeviceId: () => string | null;
			};
			relayAvailable = adapter.isAvailable();
			relayDeviceId = adapter.getExtensionDeviceId();
		} catch {
			// Relay adapter not available
		}

		return {
			connected: directConnected || relayAvailable,
			clientCount: this.clients.size,
			wsPath: BROWSER_BRIDGE_CONSTANTS.WS_PATH,
			relayAvailable,
			relayDeviceId,
		};
	}

	/**
	 * Check if a Chrome Extension is reachable (direct WS or Cloud relay).
	 *
	 * @returns True if connected via direct WS or relay is available
	 */
	isConnected(): boolean {
		// Check for an active (OPEN) direct WS client — not just map size,
		// because stale clients with readyState !== OPEN can linger briefly.
		if (this.getActiveClient() !== null) return true;

		// Check relay fallback
		try {
			const { BrowserRelayAdapter } = require('./browser-relay-adapter.service.js');
			const adapter = BrowserRelayAdapter.getInstance() as {
				isAvailable: () => boolean;
			};
			return adapter.isAvailable();
		} catch {
			return false;
		}
	}

	/**
	 * Get the first active (OPEN) client, cleaning up stale ones.
	 *
	 * @returns Active BrowserClient or null
	 */
	private getActiveClient(): BrowserClient | null {
		for (const [id, client] of this.clients) {
			if (client.ws.readyState === WebSocket.OPEN) {
				return client;
			}
			// Clean up stale clients
			this.clients.delete(id);
		}
		return null;
	}

	/**
	 * Shut down the WebSocket server and disconnect all clients.
	 */
	stop(): void {
		// Clear all pending commands
		for (const [id, pending] of this.pendingCommands) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Crewly in Chrome bridge shutting down'));
			this.pendingCommands.delete(id);
		}

		// Close all client connections
		for (const [id, client] of this.clients) {
			try {
				client.ws.close(1001, 'Server shutting down');
			} catch {
				// Ignore close errors
			}
			this.clients.delete(id);
		}

		// Close the WebSocket server
		if (this.wss) {
			this.wss.close();
			this.wss = null;
		}

		this.logger.info('Crewly in Chrome bridge stopped');
	}
}

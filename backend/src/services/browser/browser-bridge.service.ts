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
// Static import of the relay adapter — this module is always shipped
// alongside browser-bridge in dist/, and its TypeScript-only back-import
// of `BrowserCommand` / `BrowserCommandResponse` from this file is
// erased at runtime, so the cycle is type-only and safe under ESM.
//
// Previously this was a lazy `nodeRequire` (entry-script-anchored CJS
// createRequire) so `getStatus` / `isConnected` could stay synchronous.
// That anchor broke relative-path resolution at runtime — see
// `backend/src/utils/node-require.utils.ts` JSDoc for the lessons.
// Static import keeps sync method signatures AND fixes the resolution.
import { BrowserRelayAdapter } from './browser-relay-adapter.service.js';

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
	/** Number of currently active agent→tab bindings (per-tab dispatch). */
	bindingCount?: number;
}

/**
 * Per-tab dispatch (1 agent : 1 tab) — see
 * `.crewly/specs/crewly-in-chrome-per-tab-fix-2026-04-25.md`.
 *
 * Each binding records which agentSession owns which Extension tab, plus
 * a recency stamp used by the TTL sweep to evict idle bindings.
 */
export interface AgentTabBinding {
	/** Owning agent session (`X-Agent-Session` header value). */
	agentSession: string;
	/** Chrome tab id this agent has been bound to. */
	tabId: number;
	/** Window id the tab lives in (tracked for cross-window heuristics). */
	windowId?: number;
	/** Wall-clock time when the binding was first established. */
	boundAt: Date;
	/** Wall-clock time of the last command that touched this binding. Reset on activity. */
	lastActivityAt: Date;
}

/**
 * Tab descriptor reported by the Extension during the post-reconnect
 * inventory handshake (§4.4 Reconnect Reconciliation).
 */
export interface ExtensionTabDescriptor {
	tabId: number;
	url?: string;
	title?: string;
	windowId?: number;
	/** True when the tab is in Crewly's tab group — only these are eligible for auto-close. */
	crewlyOwned?: boolean;
}

/**
 * Reasons a tab binding can disappear. Surfaced in logs/metrics so we
 * can distinguish user-driven closes from sweep-driven evictions.
 */
export type AgentTabBindingRemovalReason =
	| 'unbind'
	| 'tab_removed'
	| 'ttl_expired'
	| 'reconcile_extension_missing'
	| 'shutdown';

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

	/**
	 * Per-agent tab bindings (per-tab dispatch §3.2). Keyed by `agentSession`
	 * so each agent has at most one bound tab. Cleared on `unbindAgentTab`,
	 * tab-removed events from the Extension, TTL expiry, or shutdown.
	 */
	private agentTabBindings: Map<string, AgentTabBinding> = new Map();

	/** Periodic timer that evicts idle bindings (§4.2). Only running while attached. */
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	/** Last time we logged the soft-cap warning, used to throttle to once per sweep cycle. */
	private softWarnLoggedAt: number = 0;

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

		// Begin per-tab binding TTL sweep — only useful once attached.
		this.startSweepTimer();

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

			// Handle tab-removed event from the Extension (per-tab dispatch §4.3).
			// User manually closed a Crewly tab, or Chrome reaped it — clear the binding.
			if (msg.type === 'tabRemoved' && typeof msg.tabId === 'number') {
				this.handleTabRemoved(msg.tabId);
				return;
			}

			// Handle tab inventory from the Extension (§4.4 reconciliation handshake).
			// Sent by the Extension after each WS connection is established.
			if (msg.type === 'tabInventory' && Array.isArray(msg.tabs)) {
				const tabs = (msg.tabs as ExtensionTabDescriptor[]).filter(
					(t) => typeof t?.tabId === 'number'
				);
				const { orphans } = this.handleTabInventory(tabs);
				// Ask the Extension to close orphan Crewly tabs. Best-effort —
				// failures here only mean the tabs linger; users can close them.
				const client = this.clients.get(clientId);
				if (client && client.ws.readyState === WebSocket.OPEN) {
					for (const tabId of orphans) {
						try {
							const id = `cmd-orphan-${++this.commandCounter}-${Date.now()}`;
							client.ws.send(
								JSON.stringify({ id, tool: 'unbindTab', params: { tabId } })
							);
						} catch (err) {
							this.logger.warn('Failed to send orphan unbindTab', {
								tabId,
								error: (err as Error).message,
							});
						}
					}
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

		// Fallback when no direct WS client is connected.
		//
		// Preferred path: BrowserProxyService.sendCommand — this routes through
		// the proxy's own WS to the Cloud relay's addressed-messaging channel
		// (relay_to), which is the channel the extension actually pushes its
		// presence and listens on. This is the path that worked on 5/20 when
		// pairing was healthy.
		//
		// Legacy fallback: BrowserRelayAdapter.sendViaRelay — routes through
		// CloudSyncService.sendMessage(deviceId). Current production keeps the
		// adapter wired but Sync only tracks orchestrator-role devices, so
		// the adapter cannot actually deliver to a browser even when its
		// `isAvailable()` returns true (the 2026-05-23 bug). Keep this branch
		// as a hedge for any deployment that still bridges browser presence
		// through Sync; in practice it should be unreachable now.
		if (!client) {
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const proxy = BrowserProxyService.getInstance();
			if (proxy.isAvailable()) {
				this.logger.info('No direct WS client, routing via BrowserProxy', { tool });
				return proxy.sendCommand(tool, params, undefined, timeoutMs, agentName);
			}
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const relayAdapter = BrowserRelayAdapter.getInstance();
			if (relayAdapter.isAvailable()) {
				this.logger.info('No direct WS client and no proxy, routing via legacy adapter', { tool });
				return relayAdapter.sendViaRelay(tool, params, timeoutMs, agentName);
			}
			throw new Error('No Chrome Extension connected (direct WS, BrowserProxy, or Cloud relay)');
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

	// -------------------------------------------------------------------------
	// Per-tab dispatch (§3.2 — 1 agent : 1 tab binding)
	// -------------------------------------------------------------------------

	/**
	 * Look up the current binding for an agent session, if any. Read-only —
	 * does NOT update `lastActivityAt`. Use `sendCommandForAgent` for the
	 * activity-tracking lookup path.
	 *
	 * @param agentSession `X-Agent-Session` header value.
	 * @returns The binding, or `undefined` if this agent has no bound tab.
	 */
	getBinding(agentSession: string): AgentTabBinding | undefined {
		return this.agentTabBindings.get(agentSession);
	}

	/**
	 * Snapshot the current bindings as a plain array — used by `GET
	 * /api/browser/bindings` and by tests.
	 */
	listBindings(): AgentTabBinding[] {
		return Array.from(this.agentTabBindings.values()).map((b) => ({ ...b }));
	}

	/**
	 * Bind an agent to a fresh Chrome tab via the Extension. Idempotent: if
	 * the agent already has a binding, return it instead of creating a new
	 * tab (avoids tab leak when skill cache and backend disagree under
	 * concurrent calls).
	 *
	 * @param agentSession Owning agent session.
	 * @param opts.foreground Pass `active: true` to the Extension on create.
	 *   Defaults to `false` so the user's foreground tab is never disturbed.
	 * @param opts.timeoutMs Optional override for the create-tab WS round-trip.
	 * @returns The (possibly pre-existing) binding.
	 * @throws `Error` with a `tab_pool_full` cause when at hard cap.
	 */
	async bindAgentTab(
		agentSession: string,
		opts: { foreground?: boolean; timeoutMs?: number; agentName?: string } = {}
	): Promise<AgentTabBinding> {
		if (!agentSession) {
			throw new Error('bindAgentTab requires a non-empty agentSession');
		}

		// Idempotent: existing binding short-circuits creation.
		const existing = this.agentTabBindings.get(agentSession);
		if (existing) {
			existing.lastActivityAt = new Date();
			return existing;
		}

		const cap = this.getTabPoolCap();
		if (this.agentTabBindings.size >= cap) {
			const err = new Error(
				`tab_pool_full: ${this.agentTabBindings.size} bindings at hard cap ${cap}`
			);
			(err as Error & { code?: string }).code = 'tab_pool_full';
			throw err;
		}

		const response = await this.sendCommand(
			'bindTab',
			{ active: opts.foreground === true },
			opts.timeoutMs,
			opts.agentName
		);

		if (!response.success) {
			throw new Error(`Extension refused bindTab: ${response.error ?? 'unknown error'}`);
		}

		const result = (response.result ?? {}) as { tabId?: number; windowId?: number };
		if (typeof result.tabId !== 'number') {
			throw new Error('Extension bindTab response missing numeric tabId');
		}

		const binding: AgentTabBinding = {
			agentSession,
			tabId: result.tabId,
			windowId: result.windowId,
			boundAt: new Date(),
			lastActivityAt: new Date(),
		};
		this.agentTabBindings.set(agentSession, binding);

		this.maybeWarnSoftCap();

		this.logger.info('Agent tab bound', {
			agentSession,
			tabId: binding.tabId,
			windowId: binding.windowId,
			bindingCount: this.agentTabBindings.size,
		});

		return { ...binding };
	}

	/**
	 * Release an agent's bound tab. Optionally instruct the Extension to
	 * close the tab as well (default: true). Safe to call when no binding
	 * exists — returns `{ released: false, tabClosed: false }` instead of
	 * throwing.
	 */
	async unbindAgentTab(
		agentSession: string,
		opts: { closeTab?: boolean; reason?: AgentTabBindingRemovalReason; timeoutMs?: number } = {}
	): Promise<{ released: boolean; tabClosed: boolean }> {
		const closeTab = opts.closeTab !== false;
		const binding = this.agentTabBindings.get(agentSession);
		if (!binding) {
			return { released: false, tabClosed: false };
		}

		this.agentTabBindings.delete(agentSession);

		let tabClosed = false;
		if (closeTab) {
			try {
				const resp = await this.sendCommand(
					'unbindTab',
					{ tabId: binding.tabId },
					opts.timeoutMs
				);
				tabClosed = resp.success === true;
			} catch (err) {
				// Non-fatal — Extension may be offline or tab already gone. Log and move on.
				this.logger.warn('unbindTab Extension call failed (binding still cleared)', {
					agentSession,
					tabId: binding.tabId,
					error: (err as Error).message,
				});
			}
		}

		this.logger.info('Agent tab unbound', {
			agentSession,
			tabId: binding.tabId,
			reason: opts.reason ?? 'unbind',
			tabClosed,
			bindingCount: this.agentTabBindings.size,
		});

		return { released: true, tabClosed };
	}

	/**
	 * Send a command on behalf of an agent. Resolution priority (matches §4.2):
	 *
	 *   1. Explicit `tabId` in `params` — used as-is, NO ownership check
	 *      (legacy testing/debug only; controller layer is responsible for
	 *      enforcing cross-agent ownership rules before reaching here).
	 *   2. `agentSession` provided AND has a binding — inject bound tabId,
	 *      bump `lastActivityAt`.
	 *   3. `agentSession` provided AND no binding — auto-bind first, then
	 *      forward the original command with the new tabId.
	 *   4. No `agentSession` — pass through to plain `sendCommand` (active-tab
	 *      fallback in Extension, preserving backward compat).
	 *
	 * @param agentSession Owning agent session, or `undefined` for legacy fallback.
	 * @param tool Tool name (e.g. `navigate`, `read-text`).
	 * @param params Tool params; if it contains `tabId` we treat as explicit override.
	 * @param timeoutMs Optional command timeout.
	 * @param agentName Optional agent name for the Extension banner.
	 */
	async sendCommandForAgent(
		agentSession: string | undefined,
		tool: string,
		params?: Record<string, unknown>,
		timeoutMs?: number,
		agentName?: string
	): Promise<BrowserCommandResponse> {
		// Path 1: explicit tabId override — pass through, log so it's auditable.
		if (params && typeof (params as { tabId?: unknown }).tabId === 'number') {
			this.logger.debug('sendCommandForAgent: explicit tabId override', {
				agentSession,
				tabId: (params as { tabId?: number }).tabId,
				tool,
			});
			return this.sendCommand(tool, params, timeoutMs, agentName);
		}

		// Path 4: no agent session — legacy active-tab path.
		if (!agentSession) {
			return this.sendCommand(tool, params, timeoutMs, agentName);
		}

		// Path 2 / 3: resolve binding, auto-bind on miss.
		let binding = this.agentTabBindings.get(agentSession);
		if (!binding) {
			binding = await this.bindAgentTab(agentSession, { agentName, timeoutMs });
		}

		binding.lastActivityAt = new Date();

		const merged: Record<string, unknown> = { ...(params ?? {}), tabId: binding.tabId };
		return this.sendCommand(tool, merged, timeoutMs, agentName);
	}

	/**
	 * Handle a `tabRemoved` event from the Extension (§4.3 — fires when
	 * the user manually closes a Crewly tab or when Chrome reaps it).
	 * Idempotent: tabs not in any binding are ignored.
	 */
	handleTabRemoved(tabId: number): void {
		for (const [agentSession, binding] of this.agentTabBindings) {
			if (binding.tabId === tabId) {
				this.agentTabBindings.delete(agentSession);
				this.logger.info('Binding cleared (tab closed in Extension)', {
					agentSession,
					tabId,
					reason: 'tab_removed',
					bindingCount: this.agentTabBindings.size,
				});
				return;
			}
		}
	}

	/**
	 * Reconcile bindings against the Extension's current tab inventory
	 * (§4.4). Called whenever a fresh WS connection completes the post-
	 * reconnect handshake.
	 *
	 * - For each backend binding whose tabId no longer exists in the
	 *   Extension → drop the binding (`reconcile_extension_missing`).
	 * - For each Extension tab that is Crewly-owned but unknown to any
	 *   binding → ask the Extension to close it (orphan cleanup).
	 *
	 * Caller is responsible for actually sending the close commands; this
	 * method returns the orphan list rather than firing `unbindTab` itself
	 * to keep the function pure-ish and easier to test.
	 *
	 * @returns Orphan tabs the caller should close.
	 */
	handleTabInventory(extensionTabs: ExtensionTabDescriptor[]): { orphans: number[] } {
		const extensionTabIds = new Set(
			extensionTabs.filter((t) => typeof t.tabId === 'number').map((t) => t.tabId)
		);
		const boundTabIds = new Set(
			Array.from(this.agentTabBindings.values()).map((b) => b.tabId)
		);

		// Drop stale bindings.
		for (const [agentSession, binding] of this.agentTabBindings) {
			if (!extensionTabIds.has(binding.tabId)) {
				this.agentTabBindings.delete(agentSession);
				this.logger.info('Binding cleared (tab missing from Extension inventory)', {
					agentSession,
					tabId: binding.tabId,
					reason: 'reconcile_extension_missing',
				});
			}
		}

		// Identify Crewly-owned orphans (tabs in Crewly group with no binding).
		const orphans: number[] = [];
		for (const tab of extensionTabs) {
			if (typeof tab.tabId !== 'number') continue;
			if (!tab.crewlyOwned) continue; // never auto-close user's regular tabs
			if (!boundTabIds.has(tab.tabId)) {
				orphans.push(tab.tabId);
			}
		}

		if (orphans.length > 0) {
			this.logger.info('Reconcile found Crewly-owned orphan tabs', {
				orphanCount: orphans.length,
				orphanTabIds: orphans,
			});
		}

		return { orphans };
	}

	/** Effective hard cap, allowing env override `CREWLY_TAB_BIND_MAX`. */
	private getTabPoolCap(): number {
		const raw = process.env['CREWLY_TAB_BIND_MAX'];
		if (raw) {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n > 0) return n;
		}
		return BROWSER_BRIDGE_CONSTANTS.TAB_BIND_HARD_CAP;
	}

	/** Effective TTL in ms, allowing env override `CREWLY_TAB_BIND_TTL_MINUTES`. */
	private getTabBindingTtlMs(): number {
		const raw = process.env['CREWLY_TAB_BIND_TTL_MINUTES'];
		const minutes =
			raw && Number.isFinite(Number.parseFloat(raw)) && Number.parseFloat(raw) > 0
				? Number.parseFloat(raw)
				: BROWSER_BRIDGE_CONSTANTS.TAB_BIND_TTL_MINUTES;
		return minutes * 60 * 1000;
	}

	/**
	 * Soft warning ping when bindings cross the warn threshold. Throttled
	 * to once per sweep cycle so we don't flood the logs during a burst.
	 */
	private maybeWarnSoftCap(): void {
		if (this.agentTabBindings.size < BROWSER_BRIDGE_CONSTANTS.TAB_BIND_SOFT_WARN) return;
		const now = Date.now();
		if (now - this.softWarnLoggedAt < BROWSER_BRIDGE_CONSTANTS.TAB_BIND_SWEEP_MS) return;
		this.softWarnLoggedAt = now;
		this.logger.warn('Browser bindings crossed soft warn threshold', {
			bindingCount: this.agentTabBindings.size,
			softWarnAt: BROWSER_BRIDGE_CONSTANTS.TAB_BIND_SOFT_WARN,
			hardCap: this.getTabPoolCap(),
		});
	}

	/**
	 * Run the TTL sweep once. Idle bindings (`lastActivityAt + TTL < now`)
	 * are removed. Sends `unbindTab` to the Extension when a client is
	 * connected, but never fails the sweep on Extension errors.
	 *
	 * Exported via `runSweepOnce` for tests so we don't have to advance
	 * fake timers across the full 5-minute interval.
	 *
	 * @returns Number of bindings evicted in this pass.
	 */
	async runSweepOnce(): Promise<number> {
		const ttlMs = this.getTabBindingTtlMs();
		const now = Date.now();
		const expired: Array<{ agentSession: string; tabId: number }> = [];
		for (const [agentSession, binding] of this.agentTabBindings) {
			if (now - binding.lastActivityAt.getTime() > ttlMs) {
				expired.push({ agentSession, tabId: binding.tabId });
			}
		}

		for (const { agentSession } of expired) {
			await this.unbindAgentTab(agentSession, {
				closeTab: true,
				reason: 'ttl_expired',
			}).catch((err: unknown) => {
				this.logger.warn('Sweep unbind failed (binding still removed)', {
					agentSession,
					error: (err as Error).message,
				});
			});
		}

		return expired.length;
	}

	private startSweepTimer(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => {
			this.runSweepOnce().catch((err: unknown) => {
				this.logger.error('TTL sweep crashed', { error: (err as Error).message });
			});
		}, BROWSER_BRIDGE_CONSTANTS.TAB_BIND_SWEEP_MS);
		// Don't keep the event loop alive solely for the sweep timer.
		if (typeof this.sweepTimer.unref === 'function') {
			this.sweepTimer.unref();
		}
	}

	private stopSweepTimer(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
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

		// Primary: BrowserProxy. The proxy talks directly to the Cloud
		// relay's browser channel (browser_list / browser_event) and is the
		// canonical source of truth for extension presence since 2026-05-23.
		// Lazy-require via getStaticProxy() so we don't introduce an
		// import-time circular dep — BrowserBridge is the entry point for
		// browser dispatch and other services already reach back into it.
		try {
			const proxy = this.tryGetProxyInstance();
			if (proxy) {
				const proxyAvailable = proxy.isAvailable();
				if (proxyAvailable) {
					relayAvailable = true;
					const first = proxy.getInstances()[0];
					if (first) relayDeviceId = first.instanceId;
				}
			}
		} catch {
			// Proxy not yet wired — fall through to adapter.
		}

		// Fallback: legacy adapter (CloudSync-driven). Kept so any
		// deployment still using the Sync-broadcast model keeps working.
		// In current production this branch reports `false` because Sync
		// doesn't carry browser-role devices.
		if (!relayAvailable) {
			try {
				const adapter = BrowserRelayAdapter.getInstance() as unknown as {
					isAvailable: () => boolean;
					getExtensionDeviceId: () => string | null;
				};
				relayAvailable = adapter.isAvailable();
				relayDeviceId = adapter.getExtensionDeviceId();
			} catch {
				// Relay adapter not available
			}
		}

		return {
			connected: directConnected || relayAvailable,
			clientCount: this.clients.size,
			wsPath: BROWSER_BRIDGE_CONSTANTS.WS_PATH,
			relayAvailable,
			relayDeviceId,
			bindingCount: this.agentTabBindings.size,
		};
	}

	/**
	 * Best-effort getter for the BrowserProxyService singleton, hidden behind
	 * a try/require so importing it eagerly never deadlocks BrowserBridge's
	 * boot path. Returns null if the proxy module isn't present (test
	 * fixtures) or hasn't been instantiated yet.
	 */
	private tryGetProxyInstance(): {
		isAvailable: () => boolean;
		getInstances: () => Array<{ instanceId: string; instanceName: string }>;
	} | null {
		try {
			// require() is fine here: BrowserProxyService also lives under
			// backend/src/services/browser, so the resolution is local and
			// doesn't trip the dynamic-import + ESM treadmill.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const mod = require('./browser-proxy.service.js');
			return mod?.BrowserProxyService?.getInstance?.() ?? null;
		} catch {
			return null;
		}
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

		// Primary fallback: BrowserProxy direct-relay channel.
		try {
			const proxy = this.tryGetProxyInstance();
			if (proxy?.isAvailable()) return true;
		} catch {
			// Proxy not yet wired
		}

		// Legacy fallback: CloudSync-driven adapter.
		try {
			const adapter = BrowserRelayAdapter.getInstance() as unknown as {
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
		// Stop the per-tab binding TTL sweep before tearing down state.
		this.stopSweepTimer();

		// Clear pending agent→tab bindings without sending unbindTab to the
		// Extension — process is exiting; orphan cleanup happens on next
		// reconnect handshake (§4.4) instead.
		if (this.agentTabBindings.size > 0) {
			this.logger.info('Bridge shutting down with active bindings', {
				bindingCount: this.agentTabBindings.size,
			});
			this.agentTabBindings.clear();
		}

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

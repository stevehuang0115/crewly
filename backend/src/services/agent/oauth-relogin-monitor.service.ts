/**
 * OAuth Relogin Monitor Service
 *
 * Monitors PTY session output for OAuth token expiry errors and orchestrates
 * the full human-in-the-loop OAuth re-authentication flow:
 *
 * 1. **Detect**: Watch PTY output for authentication_error + expired token
 * 2. **Login**: Auto-send `/login` command to trigger OAuth flow
 * 3. **Capture**: Extract the OAuth URL from PTY output after /login
 * 4. **Notify**: Emit `agent:oauth_url` event so orchestrator/Slack can forward to user
 * 5. **Callback**: Accept auth code via API and write it to PTY to complete login
 *
 * Follows the PTY subscription pattern from ContextWindowMonitorService and
 * RuntimeExitMonitorService.
 *
 * @module services/agent/oauth-relogin-monitor
 */

import { v4 as uuidv4 } from 'uuid';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
	getSessionBackendSync,
} from '../session/index.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';
import {
	OAUTH_RELOGIN_CONSTANTS,
	OAUTH_ERROR_PATTERN_SETS,
	LOGIN_REQUIRED_PATTERN_SETS,
	LOGIN_REQUIRED_CONSTANTS,
	ORCHESTRATOR_SESSION_NAME,
	RUNTIME_TYPES,
} from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * URL capture mode — active after /login is sent, waiting for OAuth URL.
 */
type CaptureMode = 'idle' | 'capturing';

/**
 * Per-session OAuth relogin monitoring state.
 */
export interface OAuthMonitorState {
	/** PTY session name */
	sessionName: string;
	/** Runtime type (determines whether Escape key is safe) */
	runtimeType: RuntimeType;
	/** Function to unsubscribe from PTY data events */
	unsubscribe: () => void;
	/** Rolling buffer for terminal output */
	buffer: string;
	/** Timestamp when monitoring started */
	startedAt: number;
	/** Timestamp of last /login command sent */
	lastReloginAt: number;
	/** Whether a relogin is currently in progress (debounce guard) */
	reloginInProgress: boolean;
	/** Timestamps of recent relogin attempts for rate limiting */
	attemptTimestamps: number[];
	/** Debounce timer handle */
	debounceTimer: ReturnType<typeof setTimeout> | null;
	/** Current URL capture mode */
	captureMode: CaptureMode;
	/** Buffer specifically for URL capture (separate from error detection buffer) */
	captureBuffer: string;
	/** Timeout timer for URL capture — gives up after URL_CAPTURE_TIMEOUT_MS */
	captureTimeoutTimer: ReturnType<typeof setTimeout> | null;
	/** Last captured OAuth URL (for debugging/testing) */
	lastCapturedUrl: string | null;
}

/**
 * OAuth URL event payload emitted on the EventBus.
 */
export interface OAuthUrlEventPayload {
	/** PTY session name */
	sessionName: string;
	/** OAuth URL that the user needs to visit */
	url: string;
}

/**
 * What the monitor extracted from a sign-in screen.
 */
export interface LoginRequiredDetection {
	/** Login URL, or null when the screen names no URL (e.g. a bare "Sign in with ChatGPT") */
	url: string | null;
	/** Device / authorization code (e.g. `FBVZ-MJHKK`), or null for browser-callback flows */
	code: string | null;
}

/**
 * A session currently waiting on a human sign-in. Held in memory only —
 * it describes the live screen, and a stale flag after restart would mislead.
 */
export interface LoginRequiredInfo extends LoginRequiredDetection {
	/** PTY session name */
	sessionName: string;
	/** Runtime type when known (unmonitored sessions found by the sweep have none) */
	runtimeType: RuntimeType | null;
	/** ISO timestamp of first detection for this url/code */
	detectedAt: string;
	/** ISO timestamp the owner was last notified for this url/code */
	notifiedAt: string | null;
}

/**
 * Minimal orchestrator message-queue surface the monitor needs to push an
 * owner-facing `[NOTIFY]` notice. Structural so tests can pass a stub.
 */
export interface LoginNoticeQueueLike {
	enqueue(input: EnqueueMessageInput): unknown;
}

/**
 * Minimal Slack surface the monitor needs. Structural so the Slack service
 * (a heavy module with its own dependency graph) can be lazily provided.
 */
export interface LoginNoticeSlackLike {
	isConnected(): boolean;
	sendNotification(notification: {
		type: 'agent_error';
		title: string;
		message: string;
		urgency: 'high';
		timestamp: string;
		metadata?: { agentId?: string };
	}): Promise<void>;
}

/**
 * Minimal chat surface (terminal gateway + chat-v2) for surfacing the notice
 * in the orchestrator conversation the owner is looking at.
 */
export interface LoginNoticeChatLike {
	/** Conversation the owner currently has open, if any */
	getActiveConversationId(): string | null;
	/** Record a system turn in that conversation */
	recordSystemTurn(conversationId: string, content: string): void;
	/** Broadcast a WebSocket system notification for a toast/banner */
	broadcastSystemNotification(message: string, type: 'warning'): void;
}

// =============================================================================
// Service
// =============================================================================

/**
 * Monitors PTY sessions for OAuth token expiry errors and orchestrates the
 * full OAuth re-authentication flow including URL capture and event notification.
 *
 * @example
 * ```typescript
 * const monitor = OAuthReloginMonitorService.getInstance();
 * monitor.setEventBusService(eventBus);
 * monitor.startMonitoring('agent-dev-001', 'claude-code');
 *
 * // User sends back auth code via API:
 * OAuthReloginMonitorService.submitOAuthCode('agent-dev-001', 'auth-code-123');
 * ```
 */
export class OAuthReloginMonitorService {
	private static instance: OAuthReloginMonitorService | null = null;
	private logger: ComponentLogger;

	/** Per-session monitoring state */
	private sessions: Map<string, OAuthMonitorState> = new Map();

	/** EventBus for publishing oauth_url events */
	private eventBusService: EventBusService | null = null;

	/** Callback invoked when an OAuth URL is captured (for orchestrator/Slack integration) */
	private onOAuthUrlCallback: ((sessionName: string, url: string) => void) | null = null;

	/** Sessions currently waiting on a human sign-in, keyed by session name */
	private loginRequired: Map<string, LoginRequiredInfo> = new Map();

	/** Orchestrator message queue for the `[NOTIFY]` notice (optional) */
	private noticeQueue: LoginNoticeQueueLike | null = null;

	/** Slack provider (lazy so the Slack module graph is not loaded at import time) */
	private slackProvider: (() => Promise<LoginNoticeSlackLike | null>) | null = null;

	/** Chat provider for the active orchestrator conversation (optional) */
	private chatProvider: (() => LoginNoticeChatLike | null) | null = null;

	/** Periodic screen sweep timer (started by `start()`) */
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('OAuthReloginMonitor');
	}

	/**
	 * Provide the orchestrator message queue used to push the owner-facing
	 * `[NOTIFY]` login notice. Skipped for the orchestrator's own session
	 * (it cannot process its queue while stuck on a sign-in screen).
	 *
	 * @param queue - Message queue (structural — the real MessageQueueService fits)
	 */
	setNoticeQueue(queue: LoginNoticeQueueLike | null): void {
		this.noticeQueue = queue;
	}

	/**
	 * Provide a lazy Slack accessor. Resolved on each notification so a Slack
	 * connection established after boot is still used.
	 *
	 * @param provider - Returns the Slack service, or null when unavailable
	 */
	setSlackProvider(provider: (() => Promise<LoginNoticeSlackLike | null>) | null): void {
		this.slackProvider = provider;
	}

	/**
	 * Provide a chat accessor for surfacing the notice in the owner's open
	 * orchestrator conversation and as a WebSocket banner.
	 *
	 * @param provider - Returns the chat surface, or null when unavailable
	 */
	setChatProvider(provider: (() => LoginNoticeChatLike | null) | null): void {
		this.chatProvider = provider;
	}

	/**
	 * Start the boot-level periodic sweep. Every `SWEEP_INTERVAL_MS` the
	 * captured screen of every live PTY session is checked for a sign-in
	 * screen — including sessions that never reached `startMonitoring`
	 * because runtime-ready detection timed out on the login screen — and
	 * flags are cleared once the screen moves past login.
	 *
	 * @param intervalMs - Sweep cadence (defaults to LOGIN_REQUIRED_CONSTANTS.SWEEP_INTERVAL_MS)
	 */
	start(intervalMs: number = LOGIN_REQUIRED_CONSTANTS.SWEEP_INTERVAL_MS): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => {
			this.sweepAllSessions();
		}, intervalMs);
		if (typeof this.sweepTimer.unref === 'function') {
			this.sweepTimer.unref();
		}
		this.logger.info('Login-required sweep started', { intervalMs });
	}

	/**
	 * Stop the periodic sweep (monitoring subscriptions are left alone).
	 */
	stop(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}

	/**
	 * Sessions currently flagged as waiting on a human sign-in.
	 *
	 * @returns Snapshot of all pending login records
	 */
	getAllLoginRequired(): LoginRequiredInfo[] {
		return [...this.loginRequired.values()];
	}

	/**
	 * The pending login record for one session, if any.
	 *
	 * @param sessionName - PTY session name
	 * @returns The record, or undefined when the session is not waiting on login
	 */
	getLoginRequired(sessionName: string): LoginRequiredInfo | undefined {
		return this.loginRequired.get(sessionName);
	}

	/**
	 * Clear a session's login-required flag (login completed, session gone,
	 * or code submitted).
	 *
	 * @param sessionName - PTY session name
	 * @returns true when a flag was cleared
	 */
	clearLoginRequired(sessionName: string): boolean {
		const existed = this.loginRequired.delete(sessionName);
		if (existed) {
			this.logger.info('Login-required flag cleared', { sessionName });
		}
		return existed;
	}

	/**
	 * Inspect screen text for a sign-in screen and extract the login URL and
	 * device code. Runtime-agnostic: the pattern sets in
	 * `LOGIN_REQUIRED_PATTERN_SETS` cover Codex (device-code and browser
	 * flows), Claude Code and Gemini CLI. Plain substring matching — no regex
	 * on untrusted length.
	 *
	 * @param screen - Captured terminal text (ANSI is stripped defensively)
	 * @returns The extracted url/code, or null when no sign-in screen is showing
	 *
	 * @example
	 * ```typescript
	 * monitor.detectLoginRequired(
	 *   'Go to https://auth.openai.com/codex/device and enter code FBVZ-MJHKK'
	 * );
	 * // → { url: 'https://auth.openai.com/codex/device', code: 'FBVZ-MJHKK' }
	 * ```
	 */
	detectLoginRequired(screen: string): LoginRequiredDetection | null {
		if (!screen || typeof screen !== 'string') return null;
		const clean = stripAnsiCodes(screen);
		const lower = clean.toLowerCase();

		const matched = LOGIN_REQUIRED_PATTERN_SETS.some((patternSet) =>
			patternSet.every((pattern) => lower.includes(pattern.toLowerCase()))
		);
		if (!matched) return null;

		return {
			url: this.extractHttpsUrl(clean, false),
			code: this.extractDeviceCode(clean),
		};
	}

	/**
	 * Check one session's current screen for a sign-in state, flag/notify on
	 * a new detection, and clear the flag once login is done.
	 *
	 * @param sessionName - PTY session name
	 * @param screen - Captured screen text
	 * @param runtimeType - Runtime type when known
	 */
	inspectScreen(sessionName: string, screen: string, runtimeType: RuntimeType | null = null): void {
		const detection = this.detectLoginRequired(screen);
		const existing = this.loginRequired.get(sessionName);

		if (!detection) {
			if (existing) {
				this.clearLoginRequired(sessionName);
			}
			return;
		}

		// Same url/code already flagged and notified recently — nothing new to say.
		if (existing && existing.url === detection.url && existing.code === detection.code) {
			const notifiedMs = existing.notifiedAt ? Date.now() - new Date(existing.notifiedAt).getTime() : Infinity;
			if (notifiedMs < LOGIN_REQUIRED_CONSTANTS.RENOTIFY_COOLDOWN_MS) {
				return;
			}
		}

		const info: LoginRequiredInfo = {
			sessionName,
			runtimeType: runtimeType ?? existing?.runtimeType ?? this.sessions.get(sessionName)?.runtimeType ?? null,
			url: detection.url,
			code: detection.code,
			detectedAt: existing && existing.url === detection.url && existing.code === detection.code
				? existing.detectedAt
				: new Date().toISOString(),
			notifiedAt: null,
		};
		this.loginRequired.set(sessionName, info);

		this.logger.warn('Agent runtime is waiting on a human sign-in', {
			sessionName,
			runtimeType: info.runtimeType,
			url: info.url,
			code: info.code,
		});

		this.notifyLoginRequired(info).catch((err) => {
			this.logger.warn('Login-required notification failed (non-fatal)', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/**
	 * Sweep every live PTY session's screen for a sign-in state.
	 * Safe to call at any time; errors are swallowed per session.
	 */
	sweepAllSessions(): void {
		const backend = getSessionBackendSync();
		if (!backend) return;

		let names: string[] = [];
		try {
			names = backend.listSessions();
		} catch {
			return;
		}

		for (const sessionName of names) {
			try {
				const screen = backend.captureOutput(sessionName, LOGIN_REQUIRED_CONSTANTS.SWEEP_CAPTURE_LINES);
				this.inspectScreen(sessionName, screen, this.sessions.get(sessionName)?.runtimeType ?? null);
			} catch (err) {
				this.logger.debug('Login-required sweep failed for session (ignored)', {
					sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Drop flags for sessions that no longer exist
		for (const flagged of [...this.loginRequired.keys()]) {
			if (!names.includes(flagged)) {
				this.clearLoginRequired(flagged);
			}
		}
	}

	/**
	 * Push the owner-facing notice everywhere a human might see it: main log,
	 * event bus, the orchestrator queue (`[NOTIFY]`, skipped when the
	 * orchestrator itself is the one stuck), the open chat conversation +
	 * WebSocket banner, and Slack when connected.
	 *
	 * @param info - The pending login record
	 */
	private async notifyLoginRequired(info: LoginRequiredInfo): Promise<void> {
		const message = this.formatLoginNotice(info);
		info.notifiedAt = new Date().toISOString();

		this.logger.warn(`[LOGIN REQUIRED] ${message}`, { sessionName: info.sessionName });

		// 1. Event bus
		if (this.eventBusService) {
			const event: AgentEvent = {
				id: uuidv4(),
				type: 'agent:login_required',
				timestamp: info.notifiedAt,
				teamId: '',
				teamName: '',
				memberId: '',
				memberName: '',
				sessionName: info.sessionName,
				previousValue: '',
				newValue: info.url ?? '',
				changedField: 'loginRequired',
				...(info.code ? { loginCode: info.code } : {}),
			};
			try {
				this.eventBusService.publish(event);
			} catch (err) {
				this.logger.warn('Failed to publish agent:login_required', {
					sessionName: info.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 2. Orchestrator queue — a [NOTIFY] the orchestrator relays to the owner.
		//    Not for the orchestrator's own session: it cannot drain its queue
		//    while parked on a sign-in screen.
		if (this.noticeQueue && info.sessionName !== ORCHESTRATOR_SESSION_NAME) {
			try {
				this.noticeQueue.enqueue({
					content: `[NOTIFY] ${message}`,
					conversationId: LOGIN_REQUIRED_CONSTANTS.ORCHESTRATOR_CONVERSATION_ID,
					source: 'system_event',
					targetSession: ORCHESTRATOR_SESSION_NAME,
					sourceMetadata: {
						eventType: 'agent:login_required',
						sessionName: info.sessionName,
						url: info.url,
						code: info.code,
					},
				});
			} catch (err) {
				this.logger.warn('Failed to enqueue login notice for orchestrator', {
					sessionName: info.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 3. Open chat conversation + WebSocket banner
		if (this.chatProvider) {
			try {
				const chat = this.chatProvider();
				if (chat) {
					const conversationId = chat.getActiveConversationId();
					if (conversationId) {
						chat.recordSystemTurn(conversationId, `[Login required] ${message}`);
					}
					chat.broadcastSystemNotification(message, 'warning');
				}
			} catch (err) {
				this.logger.warn('Failed to surface login notice in chat', {
					sessionName: info.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 4. Slack when connected
		if (this.slackProvider) {
			try {
				const slack = await this.slackProvider();
				if (slack && slack.isConnected()) {
					await slack.sendNotification({
						type: 'agent_error',
						title: 'Agent needs you to sign in',
						message,
						urgency: 'high',
						timestamp: info.notifiedAt,
						metadata: { agentId: info.sessionName },
					});
				}
			} catch (err) {
				this.logger.warn('Failed to send login notice to Slack', {
					sessionName: info.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Human-readable notice: "Agent X needs you to sign in: <url> code <XXXX-XXXXX>".
	 *
	 * @param info - The pending login record
	 * @returns The notice text
	 */
	private formatLoginNotice(info: LoginRequiredInfo): string {
		const parts = [`Agent ${info.sessionName} needs you to sign in`];
		if (info.url) parts.push(`: ${info.url}`);
		if (info.code) parts.push(` code ${info.code}`);
		if (!info.url && !info.code) parts.push(' (open its terminal to complete login)');
		return parts.join('');
	}

	/**
	 * Find a device/authorization code such as `FBVZ-MJHKK`: an upper-case
	 * alphanumeric head of `DEVICE_CODE_HEAD_LEN` chars, a dash, and a tail of
	 * `DEVICE_CODE_TAIL_MIN_LEN`..`DEVICE_CODE_TAIL_MAX_LEN` chars, delimited by
	 * non-alphanumerics. Linear scan, no regex.
	 *
	 * @param text - Screen text
	 * @returns The first code found, or null
	 */
	private extractDeviceCode(text: string): string | null {
		const { DEVICE_CODE_HEAD_LEN, DEVICE_CODE_TAIL_MIN_LEN, DEVICE_CODE_TAIL_MAX_LEN } = LOGIN_REQUIRED_CONSTANTS;
		const isCodeChar = (ch: string): boolean => (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
		const isWordChar = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);

		let i = 0;
		while (i < text.length) {
			// Candidate must start at a word boundary
			if (i > 0 && isWordChar(text[i - 1])) { i++; continue; }

			let head = 0;
			while (head < DEVICE_CODE_HEAD_LEN && i + head < text.length && isCodeChar(text[i + head])) head++;
			if (head !== DEVICE_CODE_HEAD_LEN || text[i + head] !== '-') { i++; continue; }

			let tail = 0;
			const tailStart = i + head + 1;
			while (tail < DEVICE_CODE_TAIL_MAX_LEN && tailStart + tail < text.length && isCodeChar(text[tailStart + tail])) tail++;
			const after = text[tailStart + tail];
			if (tail >= DEVICE_CODE_TAIL_MIN_LEN && (after === undefined || !isWordChar(after))) {
				return text.slice(i, tailStart + tail);
			}
			i++;
		}
		return null;
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The OAuthReloginMonitorService singleton
	 */
	static getInstance(): OAuthReloginMonitorService {
		if (!OAuthReloginMonitorService.instance) {
			OAuthReloginMonitorService.instance = new OAuthReloginMonitorService();
		}
		return OAuthReloginMonitorService.instance;
	}

	/**
	 * Reset the singleton (for testing).
	 */
	static resetInstance(): void {
		if (OAuthReloginMonitorService.instance) {
			OAuthReloginMonitorService.instance.destroy();
		}
		OAuthReloginMonitorService.instance = null;
	}

	/**
	 * Set the EventBus dependency for publishing OAuth URL events.
	 *
	 * @param eventBus - The EventBusService instance
	 */
	setEventBusService(eventBus: EventBusService): void {
		this.eventBusService = eventBus;
	}

	/**
	 * Register a callback invoked when an OAuth URL is captured.
	 * Used for direct notification (e.g., Slack) without going through EventBus subscriptions.
	 *
	 * @param callback - Called with (sessionName, oauthUrl)
	 */
	setOnOAuthUrlCallback(callback: (sessionName: string, url: string) => void): void {
		this.onOAuthUrlCallback = callback;
	}

	/**
	 * Submit an OAuth authorization code to a session's PTY.
	 *
	 * After the user visits the OAuth URL and gets an auth code, this method
	 * writes the code into the agent's PTY session to complete authentication.
	 *
	 * @param sessionName - PTY session name
	 * @param code - OAuth authorization code from the user
	 * @returns True if the code was written successfully
	 */
	static submitOAuthCode(sessionName: string, code: string): boolean {
		const backend = getSessionBackendSync();
		if (!backend) {
			return false;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			return false;
		}

		// Write the code followed by Enter
		session.write(code + '\r');

		const instance = OAuthReloginMonitorService.instance;
		if (instance) {
			instance.logger.info('OAuth code submitted to session', { sessionName });

			// Reset capture mode
			const state = instance.sessions.get(sessionName);
			if (state) {
				state.captureMode = 'idle';
				state.captureBuffer = '';
				if (state.captureTimeoutTimer) {
					clearTimeout(state.captureTimeoutTimer);
					state.captureTimeoutTimer = null;
				}
			}
			instance.clearLoginRequired(sessionName);
		}

		return true;
	}

	/**
	 * Start monitoring a PTY session for OAuth token expiry errors.
	 *
	 * Subscribes to the session's PTY onData events and watches for
	 * authentication error patterns in the output.
	 *
	 * @param sessionName - PTY session name
	 * @param runtimeType - Agent runtime type (claude-code, gemini-cli, codex-cli)
	 */
	startMonitoring(sessionName: string, runtimeType: RuntimeType): void {
		// Stop any existing monitoring for this session
		if (this.sessions.has(sessionName)) {
			this.stopMonitoring(sessionName);
		}

		const backend = getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Cannot start OAuth monitoring: session backend not initialized', { sessionName });
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			this.logger.warn('Cannot start OAuth monitoring: session not found', { sessionName });
			return;
		}

		// Subscribe to PTY data
		const unsubscribe = session.onData((data: string) => {
			this.handleData(sessionName, data);
		});

		const state: OAuthMonitorState = {
			sessionName,
			runtimeType,
			unsubscribe,
			buffer: '',
			startedAt: Date.now(),
			lastReloginAt: 0,
			reloginInProgress: false,
			attemptTimestamps: [],
			debounceTimer: null,
			captureMode: 'idle',
			captureBuffer: '',
			captureTimeoutTimer: null,
			lastCapturedUrl: null,
		};

		this.sessions.set(sessionName, state);

		this.logger.info('Started OAuth relogin monitoring', {
			sessionName,
			runtimeType,
		});

		// The sign-in screen is usually already painted by the time we
		// subscribe, and a static screen produces no further onData — so
		// inspect what is on screen right now.
		try {
			const screen = backend.captureOutput(sessionName, LOGIN_REQUIRED_CONSTANTS.SWEEP_CAPTURE_LINES);
			this.inspectScreen(sessionName, screen, runtimeType);
		} catch {
			// Non-fatal — the periodic sweep will catch it
		}
	}

	/**
	 * Stop monitoring a PTY session.
	 *
	 * @param sessionName - PTY session name
	 */
	stopMonitoring(sessionName: string): void {
		const state = this.sessions.get(sessionName);
		if (!state) {
			return;
		}

		if (state.debounceTimer) {
			clearTimeout(state.debounceTimer);
		}
		if (state.captureTimeoutTimer) {
			clearTimeout(state.captureTimeoutTimer);
		}

		state.unsubscribe();
		this.sessions.delete(sessionName);

		this.logger.debug('Stopped OAuth relogin monitoring', { sessionName });
	}

	/**
	 * Check if a session is being monitored.
	 *
	 * @param sessionName - PTY session name
	 * @returns True if the session is being monitored
	 */
	isMonitoring(sessionName: string): boolean {
		return this.sessions.has(sessionName);
	}

	/**
	 * Get the monitoring state for a session (for testing/debugging).
	 *
	 * @param sessionName - PTY session name
	 * @returns The monitoring state or undefined
	 */
	getState(sessionName: string): OAuthMonitorState | undefined {
		return this.sessions.get(sessionName);
	}

	/**
	 * Destroy all monitoring subscriptions.
	 */
	destroy(): void {
		this.stop();
		const sessionNames = [...this.sessions.keys()];
		for (const sessionName of sessionNames) {
			this.stopMonitoring(sessionName);
		}
		this.loginRequired.clear();
		this.logger.debug('All OAuth relogin monitors destroyed');
	}

	/**
	 * Handle incoming PTY data for a monitored session.
	 *
	 * In normal mode: checks for OAuth error patterns.
	 * In capture mode: looks for OAuth URL after /login was sent.
	 *
	 * @param sessionName - PTY session name
	 * @param data - Raw PTY output data
	 */
	private handleData(sessionName: string, data: string): void {
		const state = this.sessions.get(sessionName);
		if (!state) {
			return;
		}

		// Strip ANSI codes
		const clean = stripAnsiCodes(data);

		// If in capture mode, look for OAuth URL
		if (state.captureMode === 'capturing') {
			this.handleCaptureData(state, clean);
			return;
		}

		// Skip if relogin is in progress
		if (state.reloginInProgress) {
			return;
		}

		// Append to rolling buffer (kept for URL capture and diagnostics)
		state.buffer += clean;

		// Cap buffer size
		if (state.buffer.length > OAUTH_RELOGIN_CONSTANTS.MAX_BUFFER_SIZE) {
			state.buffer = state.buffer.slice(-OAUTH_RELOGIN_CONSTANTS.MAX_BUFFER_SIZE);
		}

		// First-run / device-code sign-in screens are checked against the
		// rolling buffer (URL and code often arrive in separate chunks) and
		// are NOT subject to the startup grace period — a fresh install shows
		// the login screen within seconds of spawn, which is exactly when the
		// expiry patterns below would still be muted.
		if (this.detectLoginRequired(state.buffer)) {
			// The buffer is only the trigger — inspect the live screen so the
			// URL and code are read together and the flag clears once login is
			// done (stale login text lingers in the rolling buffer for a while).
			let screen = '';
			try {
				screen = getSessionBackendSync()?.captureOutput(sessionName, LOGIN_REQUIRED_CONSTANTS.SWEEP_CAPTURE_LINES) ?? '';
			} catch {
				// fall back to the buffer below
			}
			this.inspectScreen(sessionName, screen || state.buffer, state.runtimeType);
		}

		// Skip during startup grace period
		if (Date.now() - state.startedAt < OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS) {
			return;
		}

		// Check ONLY the incoming data chunk for OAuth error patterns.
		// The real Claude Code auth error contains all pattern strings in a single
		// output message (e.g. 'API Error: 401 {"type":"error","error":{"type":"authentication_error",...}}').
		// Checking the entire rolling buffer caused false positives when unrelated text
		// from different output events (e.g. get-agent-logs, skill output) combined
		// to match patterns across the buffer.
		if (!this.detectOAuthError(clean)) {
			return;
		}

		// Pattern matched — debounce before sending /login
		if (state.debounceTimer) {
			clearTimeout(state.debounceTimer);
		}

		state.debounceTimer = setTimeout(() => {
			this.triggerRelogin(sessionName).catch((err) => {
				this.logger.error('Failed to trigger OAuth relogin', {
					sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, OAUTH_RELOGIN_CONSTANTS.DETECTION_DEBOUNCE_MS);
	}

	/**
	 * Handle PTY data while in URL capture mode.
	 *
	 * Accumulates output and scans for an HTTPS URL that looks like an OAuth
	 * authorization endpoint.
	 *
	 * @param state - Session monitoring state
	 * @param data - Cleaned PTY output data
	 */
	private handleCaptureData(state: OAuthMonitorState, data: string): void {
		state.captureBuffer += data;

		// Cap capture buffer
		if (state.captureBuffer.length > OAUTH_RELOGIN_CONSTANTS.URL_CAPTURE_BUFFER_SIZE) {
			state.captureBuffer = state.captureBuffer.slice(-OAUTH_RELOGIN_CONSTANTS.URL_CAPTURE_BUFFER_SIZE);
		}

		// Try to extract an OAuth URL from the capture buffer.
		// OAuth URLs typically contain oauth, authorize, login, or auth in the path.
		// We use a simple approach: find any https:// URL and check for auth-related paths.
		const url = this.extractOAuthUrl(state.captureBuffer);
		if (!url) {
			return;
		}

		// URL found — stop capturing
		state.captureMode = 'idle';
		state.captureBuffer = '';
		state.lastCapturedUrl = url;

		if (state.captureTimeoutTimer) {
			clearTimeout(state.captureTimeoutTimer);
			state.captureTimeoutTimer = null;
		}

		this.logger.info('Captured OAuth URL from PTY output', {
			sessionName: state.sessionName,
			url,
		});

		// Emit event and invoke callback
		this.emitOAuthUrlEvent(state.sessionName, url);
	}

	/**
	 * Extract an OAuth URL from terminal output.
	 *
	 * Looks for HTTPS URLs that appear to be OAuth authorization endpoints.
	 * Matches URLs containing common OAuth path segments: /oauth, /authorize,
	 * /login, /auth, /consent.
	 *
	 * @param buffer - Terminal output buffer
	 * @returns The OAuth URL or null if not found
	 */
	private extractOAuthUrl(buffer: string): string | null {
		return this.extractHttpsUrl(buffer, true);
	}

	/**
	 * Extract the first `https://` URL from terminal output.
	 *
	 * @param buffer - Terminal output buffer
	 * @param requireOAuthPath - When true, the URL must contain a known
	 *   OAuth path segment (`/oauth`, `/authorize`, `/login`, `/auth`,
	 *   `/consent`, `/device`); when false any https URL qualifies (sign-in
	 *   screens name plain landing pages too)
	 * @returns The URL or null if not found
	 */
	private extractHttpsUrl(buffer: string, requireOAuthPath: boolean): string | null {
		// Match https:// URLs — extract until whitespace or end of string.
		// Using a simple, non-backtracking pattern to avoid ReDoS.
		const urlStart = buffer.indexOf('https://');
		if (urlStart === -1) {
			return null;
		}

		// Extract URL: scan forward from https:// until whitespace or control char
		let urlEnd = urlStart + 8; // past "https://"
		while (urlEnd < buffer.length) {
			const ch = buffer.charCodeAt(urlEnd);
			// Stop at whitespace, control chars, or common terminal artifacts
			if (ch <= 32 || ch === 62 /* > */ || ch === 60 /* < */) {
				break;
			}
			urlEnd++;
		}

		const url = buffer.slice(urlStart, urlEnd);

		// Validate: must have a host and look like an OAuth URL
		if (url.length < 20) {
			return null;
		}

		if (!requireOAuthPath) {
			return url;
		}

		// Check for common OAuth path segments (case-insensitive).
		// `/device` covers the Codex device-code flow (auth.openai.com/codex/device).
		const lowerUrl = url.toLowerCase();
		const oauthIndicators = ['/oauth', '/authorize', '/login', '/auth', '/consent', '/device'];
		const isOAuthUrl = oauthIndicators.some((indicator) => lowerUrl.includes(indicator));

		if (!isOAuthUrl) {
			return null;
		}

		return url;
	}

	/**
	 * Emit an `agent:oauth_url` event via the EventBus and invoke the callback.
	 *
	 * @param sessionName - PTY session name
	 * @param url - OAuth URL captured from PTY output
	 */
	private emitOAuthUrlEvent(sessionName: string, url: string): void {
		// Publish via EventBus (for subscription-based notification)
		if (this.eventBusService) {
			const event: AgentEvent = {
				id: uuidv4(),
				type: 'agent:oauth_url',
				timestamp: new Date().toISOString(),
				teamId: '',
				teamName: '',
				memberId: '',
				memberName: '',
				sessionName,
				previousValue: '',
				newValue: url,
				changedField: 'oauthUrl',
			};

			this.eventBusService.publish(event);

			this.logger.info('Published agent:oauth_url event', {
				sessionName,
				url,
			});
		}

		// Invoke direct callback (for Slack/orchestrator integration)
		if (this.onOAuthUrlCallback) {
			try {
				this.onOAuthUrlCallback(sessionName, url);
			} catch (error) {
				this.logger.warn('onOAuthUrl callback error', {
					sessionName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Detect OAuth error patterns in the buffer using string matching.
	 *
	 * Uses plain string indexOf (case-insensitive via lowercasing) instead of
	 * regex to prevent ReDoS vulnerabilities. Each pattern set requires ALL
	 * strings in the set to be present (AND logic).
	 *
	 * @param buffer - Terminal output buffer to check
	 * @returns True if an OAuth error pattern is detected
	 */
	private detectOAuthError(buffer: string): boolean {
		const lowerBuffer = buffer.toLowerCase();

		const matchedSet = OAUTH_ERROR_PATTERN_SETS.find((patternSet) =>
			patternSet.every((pattern) => lowerBuffer.includes(pattern.toLowerCase()))
		);

		if (matchedSet) {
			this.logger.info('OAuth error pattern detected', {
				matchedPatterns: matchedSet,
				bufferTail: buffer.slice(-500),
			});
		}

		return !!matchedSet;
	}

	/**
	 * Send the /login command to a PTY session to re-authenticate.
	 *
	 * After sending /login, enters URL capture mode to extract the OAuth URL
	 * from the subsequent PTY output.
	 *
	 * @param sessionName - PTY session name
	 */
	private async triggerRelogin(sessionName: string): Promise<void> {
		const state = this.sessions.get(sessionName);
		if (!state || state.reloginInProgress) {
			return;
		}

		// Check cooldown
		const now = Date.now();
		if (now - state.lastReloginAt < OAUTH_RELOGIN_CONSTANTS.RELOGIN_COOLDOWN_MS) {
			this.logger.debug('OAuth relogin skipped: cooldown active', {
				sessionName,
				cooldownRemainingMs: OAUTH_RELOGIN_CONSTANTS.RELOGIN_COOLDOWN_MS - (now - state.lastReloginAt),
			});
			return;
		}

		// Clean up old attempt timestamps outside the window
		state.attemptTimestamps = state.attemptTimestamps.filter(
			(ts) => now - ts < OAUTH_RELOGIN_CONSTANTS.ATTEMPT_WINDOW_MS
		);

		// Check attempt limit
		if (state.attemptTimestamps.length >= OAUTH_RELOGIN_CONSTANTS.MAX_ATTEMPTS_PER_WINDOW) {
			this.logger.warn('OAuth relogin skipped: max attempts reached in window', {
				sessionName,
				attempts: state.attemptTimestamps.length,
				maxAttempts: OAUTH_RELOGIN_CONSTANTS.MAX_ATTEMPTS_PER_WINDOW,
			});
			return;
		}

		// Get the session to write to
		const backend = getSessionBackendSync();
		if (!backend) {
			this.logger.warn('Cannot send /login: session backend not available', { sessionName });
			return;
		}

		const session = backend.getSession(sessionName);
		if (!session) {
			this.logger.warn('Cannot send /login: session not found', { sessionName });
			return;
		}

		state.reloginInProgress = true;

		try {
			this.logger.info('Sending /login command for OAuth re-authentication', {
				sessionName,
				runtimeType: state.runtimeType,
				attemptNumber: state.attemptTimestamps.length + 1,
			});

			// Send Escape to clear any in-progress input (skip for Gemini — Escape cancels request)
			if (state.runtimeType !== RUNTIME_TYPES.GEMINI_CLI) {
				session.write('\x1b');
				await new Promise(resolve => setTimeout(resolve, OAUTH_RELOGIN_CONSTANTS.PRE_COMMAND_DELAY_MS));
			}

			// Write the /login command
			session.write('/login\r');

			// Update tracking
			state.lastReloginAt = now;
			state.attemptTimestamps.push(now);

			// Clear error detection buffer
			state.buffer = '';

			// Enter URL capture mode to extract the OAuth URL from subsequent output
			state.captureMode = 'capturing';
			state.captureBuffer = '';

			// Set a timeout for URL capture — give up after URL_CAPTURE_TIMEOUT_MS
			if (state.captureTimeoutTimer) {
				clearTimeout(state.captureTimeoutTimer);
			}
			state.captureTimeoutTimer = setTimeout(() => {
				if (state.captureMode === 'capturing') {
					this.logger.warn('OAuth URL capture timed out', { sessionName });
					state.captureMode = 'idle';
					state.captureBuffer = '';
					state.captureTimeoutTimer = null;
				}
			}, OAUTH_RELOGIN_CONSTANTS.URL_CAPTURE_TIMEOUT_MS);

			this.logger.info('OAuth /login command sent, entering URL capture mode', {
				sessionName,
				totalAttempts: state.attemptTimestamps.length,
			});
		} finally {
			state.reloginInProgress = false;
		}
	}
}

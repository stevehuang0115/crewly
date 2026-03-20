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
	RUNTIME_TYPES,
} from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

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

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('OAuthReloginMonitor');
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
		const sessionNames = [...this.sessions.keys()];
		for (const sessionName of sessionNames) {
			this.stopMonitoring(sessionName);
		}
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

		// Check for common OAuth path segments (case-insensitive)
		const lowerUrl = url.toLowerCase();
		const oauthIndicators = ['/oauth', '/authorize', '/login', '/auth', '/consent'];
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

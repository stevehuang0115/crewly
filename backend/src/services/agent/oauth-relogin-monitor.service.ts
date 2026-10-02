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
 * When a harness re-login handler is set (the Slack re-login coordinator,
 * `services/harness/harness-relogin.service.ts`), an expired Claude Code or
 * Codex login (`login-expiry-rules.ts`) is handed to it instead: it runs ONE
 * login for the harness and asks the owner over Slack, so steps 2–5 and the
 * per-agent sign-in notice are skipped for that session.
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
	LOGIN_SCREEN_REGION,
	LOGIN_COMPLETED_MARKERS,
	LOGIN_REQUIRED_CONSTANTS,
	ORCHESTRATOR_SESSION_NAME,
	RUNTIME_TYPES,
} from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import { detectLoginExpiry } from '../harness/login-expiry-rules.js';
import { reportRuntimeLoginExpiry, reportRuntimeOutput } from '../runtime-fallback/effective-runtime.js';
import { isHarnessId } from '../harness/harness.types.js';
import type { ExpiryReport } from '../harness/harness-relogin.service.js';

/**
 * Runtimes Crewly must never type `/login` into. Antigravity CLI runs only on
 * a Gemini API key: Google does not allow third-party tools to use its
 * account (OAuth) login, and agy has no `/login` command anyway.
 */
const NO_RELOGIN_COMMAND_RUNTIMES: ReadonlySet<string> = new Set<string>([RUNTIME_TYPES.ANTIGRAVITY_CLI]);

/**
 * Sign-in pattern sets for a runtime; every runtime's when it is unknown.
 *
 * @param runtimeType - Session runtime, or null
 * @returns Pattern sets to try (AND within a set)
 */
function loginPatternSetsFor(runtimeType: RuntimeType | null): readonly (readonly string[])[] {
	if (runtimeType === null) return Object.values(LOGIN_REQUIRED_PATTERN_SETS).flat();
	return LOGIN_REQUIRED_PATTERN_SETS[runtimeType] ?? [];
}

/**
 * The part of a captured screen where a sign-in prompt can be: the last
 * `TAIL_LINES` non-empty lines, and among them the ones that are not the
 * agent's own transcript. A transcript block opens with a marker
 * (`⏺`, `⎿`, `•`, …) and runs over blank lines and indented continuation
 * lines until a line that is neither — which is why the scan covers the
 * whole screen, not just the tail.
 *
 * @param screen - ANSI-free screen text
 * @returns `tail` (every tail line) and `signInLines` (tail minus transcript)
 */
export function loginScreenRegion(screen: string): { tail: string[]; signInLines: string[] } {
	const { TAIL_LINES, TRANSCRIPT_MARKERS, TRANSCRIPT_INDENT } = LOGIN_SCREEN_REGION;
	const indent = ' '.repeat(TRANSCRIPT_INDENT);
	const lines: Array<{ text: string; transcript: boolean }> = [];
	let inBlock = false;
	for (const text of screen.split(/\r?\n/)) {
		const trimmed = text.trimStart();
		if (trimmed.length === 0) continue;
		if (TRANSCRIPT_MARKERS.some((marker) => trimmed.startsWith(marker))) {
			inBlock = true;
		} else if (!text.startsWith(indent)) {
			inBlock = false;
		}
		lines.push({ text, transcript: inBlock });
	}
	const tail = lines.slice(-TAIL_LINES);
	return {
		tail: tail.map((line) => line.text),
		signInLines: tail.filter((line) => !line.transcript).map((line) => line.text),
	};
}

/**
 * What the owner replies (in their Slack DM with Crewly) to start the phone
 * re-login for a runtime — the phrases `parseOwnerLoginRequest` accepts.
 * Only harnesses with a broker login are listed.
 */
const PHONE_RELOGIN_REPLIES: Readonly<Record<string, { label: string; reply: string }>> = {
	// The notice names the English command; 「重新登录 claude」 is still accepted as input.
	[RUNTIME_TYPES.CLAUDE_CODE]: { label: 'Claude Code', reply: 'relogin claude' },
	[RUNTIME_TYPES.CODEX_CLI]: { label: 'Codex', reply: 'relogin codex' },
};

/**
 * Owner-facing sign-in notice. Written for an owner who is on a phone, not
 * at the machine: it names the agent, gives the login link and code when the
 * screen showed them, and says what to reply to get the phone re-login.
 *
 * @param info - The pending login record
 * @param agentName - Display name of the agent (falls back to the session name)
 * @returns The notice text
 *
 * @example
 * ```typescript
 * formatLoginNotice({ sessionName: 's', runtimeType: 'claude-code', url: null, code: null, ... }, 'Atlas');
 * // → 'Atlas needs you to sign in to Claude Code. Reply "relogin claude" to Crewly and it will send you a sign-in link.'
 * ```
 */
export function formatLoginNotice(info: LoginRequiredInfo, agentName: string | null = null): string {
	const name = agentName?.trim() || info.sessionName;
	const phone = info.runtimeType ? PHONE_RELOGIN_REPLIES[info.runtimeType] : undefined;
	let text = `${name} needs you to sign in${phone ? ` to ${phone.label}` : ''}`;
	if (info.url) text += `: ${info.url}`;
	if (info.code) text += ` code ${info.code}`;
	text += '.';
	if (phone) {
		const lead = info.url || info.code ? ' Or reply' : ' Reply';
		text += `${lead} "${phone.reply}" to Crewly and it will send you a sign-in link.`;
	} else if (!info.url && !info.code) {
		text += ' It is waiting on its sign-in screen on the machine it runs on.';
	}
	return text;
}

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
 * Receives an expired harness login (the Slack re-login coordinator).
 * Returns true when it owns the re-login, so the monitor must not send
 * `/login` or its own sign-in notice for that session.
 */
export type HarnessExpiryHandler = (report: ExpiryReport) => boolean;

/** Looks up an agent's display name by its session name (null when unknown). */
export type AgentNameResolver = (sessionName: string) => Promise<string | null> | string | null;

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

	/** Slack re-login coordinator for expired harness logins (optional) */
	private harnessExpiryHandler: HarnessExpiryHandler | null = null;

	/** Session name → agent display name, for the owner-facing notice (optional) */
	private agentNameResolver: AgentNameResolver | null = null;

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
	 * Provide a session → display-name lookup so the sign-in notice names the
	 * agent ("Atlas") instead of its session id.
	 *
	 * @param resolver - Lookup, or null to fall back to the session name
	 */
	setAgentNameResolver(resolver: AgentNameResolver | null): void {
		this.agentNameResolver = resolver;
	}

	/**
	 * Display name for a session: the orchestrator's fixed name, else the
	 * resolver's answer, else null (the notice then uses the session name).
	 * Synchronous when there is nothing to look up.
	 *
	 * @param sessionName - PTY session name
	 * @returns Display name or null (or a promise of it when the resolver is async)
	 */
	private resolveAgentName(sessionName: string): string | null | Promise<string | null> {
		if (sessionName === ORCHESTRATOR_SESSION_NAME) return 'Orchestrator';
		if (!this.agentNameResolver) return null;
		try {
			const name = this.agentNameResolver(sessionName);
			return name instanceof Promise ? name.catch(() => null) : name;
		} catch {
			return null;
		}
	}

	/**
	 * Hand expired harness logins to a coordinator (Slack re-login) instead
	 * of sending `/login` into each agent and notifying per agent.
	 *
	 * @param handler - Coordinator callback, or null to restore the old behaviour
	 */
	setHarnessExpiryHandler(handler: HarnessExpiryHandler | null): void {
		this.harnessExpiryHandler = handler;
	}

	/**
	 * Check output for an expired harness login and report it to the handler.
	 * Never logs the output itself.
	 *
	 * @param sessionName - PTY session name
	 * @param output - Raw PTY chunk or captured screen
	 * @param runtimeType - Session runtime, or null to try every harness
	 * @param source - `output` (live chunk) or `screen` (sweep / captured screen)
	 * @returns True when the handler (or, for a session on another of the
	 *   owner's Claude Code accounts, the runtime fallback) owns the re-login
	 */
	private reportHarnessExpiry(
		sessionName: string,
		output: string,
		runtimeType: RuntimeType | null,
		source: 'output' | 'screen',
	): boolean {
		const match = detectLoginExpiry(output, runtimeType);
		if (!match) return false;
		// On another of the owner's Claude Code accounts (issue #942) the
		// expired login is that account's: the runtime fallback moves the agent
		// on and asks the owner to sign the account in again.
		if (reportRuntimeLoginExpiry(sessionName)) {
			if (source === 'output') this.logger.info('Expired login of another Claude Code account handed to the runtime fallback', { sessionName, rule: match.ruleId });
			return true;
		}
		if (!this.harnessExpiryHandler) return false;
		try {
			const handled = this.harnessExpiryHandler({ harnessId: match.harnessId, sessionName, source });
			if (handled) {
				// The 30s screen sweep re-reads the same scrollback: an old 401
				// stays on screen for hours (2,000+ identical INFO lines a day on
				// steamfun-ops). Live output stays at info.
				const log = source === 'screen' ? this.logger.debug.bind(this.logger) : this.logger.info.bind(this.logger);
				log('Expired harness login handed to the Slack re-login', { sessionName, harnessId: match.harnessId, rule: match.ruleId, source });
			}
			return handled;
		} catch (err) {
			this.logger.warn('Harness re-login handler failed (falling back to /login)', {
				sessionName,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
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
	 * device code. Only the runtime's own sign-in patterns are tried
	 * (`LOGIN_REQUIRED_PATTERN_SETS`; every runtime's when it is unknown).
	 * Plain substring matching — no regex on untrusted length.
	 *
	 * `screen` scope (a captured live screen — this decides): only the last
	 * `LOGIN_SCREEN_REGION.TAIL_LINES` non-empty lines count, the agent's own
	 * transcript blocks among them are skipped, and a busy runtime or one at
	 * its chat prompt is never on a sign-in screen. `trigger` scope (the
	 * rolling PTY buffer, whose redraws have no reliable "bottom") matches the
	 * whole text and is only a cue to capture and inspect the live screen.
	 *
	 * @param screen - Captured terminal text (ANSI is stripped defensively)
	 * @param runtimeType - Session runtime, or null to try every runtime's patterns
	 * @param scope - `screen` (strict, default) or `trigger` (rolling buffer)
	 * @returns The extracted url/code, or null when no sign-in screen is showing
	 *
	 * @example
	 * ```typescript
	 * monitor.detectLoginRequired(
	 *   'Go to https://auth.openai.com/codex/device and enter code FBVZ-MJHKK',
	 *   'codex-cli',
	 * );
	 * // → { url: 'https://auth.openai.com/codex/device', code: 'FBVZ-MJHKK' }
	 * ```
	 */
	detectLoginRequired(
		screen: string,
		runtimeType: RuntimeType | null = null,
		scope: 'screen' | 'trigger' = 'screen',
	): LoginRequiredDetection | null {
		if (!screen || typeof screen !== 'string') return null;
		const clean = stripAnsiCodes(screen);
		const lower = clean.toLowerCase();

		let region = clean;
		if (scope === 'screen') {
			const { tail, signInLines } = loginScreenRegion(clean);
			const tailLower = tail.join('\n').toLowerCase();
			if (LOGIN_SCREEN_REGION.NOT_SIGN_IN_MARKERS.some((marker) => tailLower.includes(marker))) return null;
			region = signInLines.join('\n');
		}
		const regionLower = region.toLowerCase();

		const matched = loginPatternSetsFor(runtimeType).some((patternSet) =>
			patternSet.every((pattern) => regionLower.includes(pattern.toLowerCase()))
		);
		if (!matched) return null;
		// Login just finished (e.g. codex's "Signed in with your ChatGPT
		// account" notice) while the old sign-in screen is still in the capture.
		if (LOGIN_COMPLETED_MARKERS.some((marker) => lower.includes(marker))) return null;

		return {
			url: this.extractHttpsUrl(region, false),
			code: this.extractDeviceCode(region),
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
		const knownRuntime = runtimeType ?? this.sessions.get(sessionName)?.runtimeType ?? null;
		// An expired login the Slack re-login coordinator owns: it DMs the
		// owner once per harness, so this session gets no notice of its own.
		let handledByRelogin = this.reportHarnessExpiry(sessionName, screen, knownRuntime, 'screen');
		const signInScreen = this.detectLoginRequired(screen, knownRuntime);
		// A sign-in screen of a runtime the coordinator can log in (an agent
		// launched while Claude Code / Codex is signed out) goes to the
		// coordinator too: one confirmed, machine-routed DM per harness instead
		// of a per-agent notice through the master bot, whose replies land on
		// the account's primary machine.
		// A sign-in screen on another of the owner's Claude Code accounts is
		// that account's: the runtime fallback moves the agent on (issue #942).
		if (!handledByRelogin && signInScreen && reportRuntimeLoginExpiry(sessionName)) handledByRelogin = true;
		if (!handledByRelogin && signInScreen && knownRuntime && this.harnessExpiryHandler && isHarnessId(knownRuntime)) {
			try {
				handledByRelogin = this.harnessExpiryHandler({ harnessId: knownRuntime, sessionName, source: 'screen' });
			} catch {
				handledByRelogin = false;
			}
		}
		// An expiry the coordinator took ("⎿ Login expired · Please run /login")
		// is in the transcript, which the sign-in-screen check skips, but the
		// agent still needs a sign-in — keep the flag for the dashboard.
		const detection = signInScreen ?? (handledByRelogin ? { url: null, code: null } : null);
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

		if (handledByRelogin) {
			info.notifiedAt = new Date().toISOString();
			return;
		}

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
		// Mark notified before the name lookup so a sweep during it does not notify twice.
		info.notifiedAt = new Date().toISOString();
		const pendingName = this.resolveAgentName(info.sessionName);
		const agentName = pendingName instanceof Promise ? await pendingName : pendingName;
		const message = formatLoginNotice(info, agentName);

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
		if (this.detectLoginRequired(state.buffer, state.runtimeType, 'trigger')) {
			// The buffer is only the trigger — the live screen decides, with the
			// strict screen rule (bottom of the screen, no transcript, not busy),
			// so an agent quoting sign-in text in its reply is not a sign-in
			// screen. It also reads URL and code together and clears the flag
			// once login is done (stale login text lingers in the buffer).
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

		// An expired Claude Code / Codex login goes to the Slack re-login
		// coordinator (one login per harness, owner finishes it on the phone)
		// instead of `/login` typed into this agent.
		if (this.reportHarnessExpiry(sessionName, data, state.runtimeType, 'output')) {
			return;
		}

		// A usage limit (not a login problem) goes to the runtime fallback,
		// which moves the agent to its next runtime until the limit resets
		// (specs/2026-10-01-runtime-fallback.md).
		if (reportRuntimeOutput(sessionName, state.runtimeType, data, 'output')) {
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
		if (NO_RELOGIN_COMMAND_RUNTIMES.has(state.runtimeType)) {
			this.logger.debug('OAuth relogin skipped: this runtime never gets /login', { sessionName, runtimeType: state.runtimeType });
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

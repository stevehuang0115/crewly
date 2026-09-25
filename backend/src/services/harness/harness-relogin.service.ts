/**
 * Harness re-login coordinator — Phase 2 of onboarding: re-login over Slack.
 *
 * When a harness login expires, Crewly notices by itself, starts ONE login
 * broker session for that harness, DMs the owner what to do on their phone,
 * and resumes the agents that were stuck once the login succeeds. Nobody
 * has to touch the machine.
 *
 * Inputs:
 * - {@link HarnessReloginService.reportExpiry} — called by the OAuth
 *   re-login monitor when an agent's terminal output matches an expiry rule
 *   (login-expiry-rules.ts), and by the periodic status check of the
 *   orchestrator's harness ({@link HarnessReloginService.checkOrcHarness}).
 * - {@link HarnessReloginService.handleOwnerReply} — an owner's Slack DM
 *   reply. A reply is consumed only when it belongs to a flow: Claude's
 *   authorization code (while Claude's login is waiting for it and the reply
 *   looks like a code), the retry keyword, or a reply to an unrecognised
 *   login screen. Everything else goes through the normal chat path.
 * - The broker's `update` / `finished` events.
 *
 * Rules:
 * - One flow per harness. Repeated detections only add stuck sessions. A
 *   flow that failed is restarted by a new detection at most once per
 *   {@link HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS} (the re-reminder),
 *   or at once when the owner replies `relogin` / `重新登录`.
 * - If Crewly holds an API key for the harness it is used silently (no DM).
 * - Claude → `subscription` (`claude setup-token`), Codex → `device`.
 * - Secrets: Claude's code is passed to the broker and never stored, logged
 *   or echoed; DMs are built from {@link LoginSession} snapshots, which never
 *   contain a token, and the screen text is redacted again.
 *
 * @module services/harness/harness-relogin.service
 */

import { HARNESS_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { HarnessApiKeyService } from './harness-api-key.service.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from './harness-credentials.store.js';
import { getBrokerLoginMethod, getHarnessDefinition } from './harness-registry.js';
import { getHarnessService } from './harness.service.js';
import {
	SILENT_HARNESS_LOGGER,
	isHarnessId,
	isTerminalLoginState,
	type HarnessId,
	type HarnessLogger,
	type LoginSession,
	type LoginState,
	type ReloginPending,
} from './harness.types.js';
import { LOGIN_BROKER_EVENTS, type LoginBrokerService } from './login-broker.service.js';
import { redactSecrets } from './login-rules.js';

/** Where an expiry report came from. */
export type ExpirySource = 'output' | 'screen' | 'status';

/** An expired-login report. */
export interface ExpiryReport {
	harnessId: HarnessId;
	/** Agent session whose output matched, or null when unknown (status check) */
	sessionName: string | null;
	/**
	 * `output`: a live PTY chunk; `screen`: the periodic screen sweep (may show
	 * old scrollback); `status`: the harness's own status command
	 */
	source: ExpirySource;
}

/** Sends a Slack DM to the owner. */
export interface ReloginOwnerNotifier {
	/**
	 * Send a DM to the owner.
	 *
	 * @param text - Slack mrkdwn text (never contains a secret)
	 * @returns True when delivered
	 */
	sendToOwner(text: string): Promise<boolean>;
}

/** Restarts agents after a login succeeded. */
export interface ReloginAgentResumer {
	/**
	 * Live agent sessions that run on a harness.
	 *
	 * @param harnessId - Harness (= runtime type)
	 * @returns Session names
	 */
	listSessions(harnessId: HarnessId): string[];
	/**
	 * Restart sessions so they pick up the new login, resuming their conversation.
	 *
	 * @param sessionNames - Sessions to restart
	 * @returns Which ones came back and which did not
	 */
	resume(sessionNames: readonly string[]): Promise<{ resumed: string[]; failed: string[] }>;
}

/** The slice of the login broker the coordinator uses. */
export type ReloginBroker = Pick<LoginBrokerService, 'start' | 'get' | 'input' | 'cancel' | 'on'>;

/** Injectable dependencies. */
export interface HarnessReloginDeps {
	broker: ReloginBroker;
	credentials: Pick<HarnessCredentialsStore, 'read' | 'getClaudeCredentialKind'>;
	apiKeys: Pick<HarnessApiKeyService, 'submit'>;
	/** The harness's login state from its own status command */
	checkLoginState: (harnessId: HarnessId) => Promise<LoginState>;
	/** The orchestrator's harness (null before setup recorded one) */
	getOrcHarness: () => Promise<string | null>;
	notifier?: ReloginOwnerNotifier | null;
	resumer?: ReloginAgentResumer | null;
	now?: () => number;
	logger?: HarnessLogger;
}

/** One re-login flow (at most one per harness). */
interface ReloginFlow {
	harnessId: HarnessId;
	/** `running`: a broker session is live; `failed`: it ended without a login */
	phase: 'running' | 'failed';
	sessionId: string | null;
	startedAt: number;
	/** Sessions whose output matched; empty = every session of the harness */
	stuck: Set<string>;
	/** What the owner has been sent for the current session */
	dm: 'none' | 'link' | 'screen';
	lastDmAt: number | null;
	/** The owner's reply has been typed into the current session */
	replied: boolean;
	/** Last rejection message DM'd, so a redraw does not repeat it */
	lastRejection: string | null;
	screenTimer: NodeJS.Timeout | null;
	/** The coordinator cancelled the session itself (restart) — do not report it */
	cancelledByUs: boolean;
}

/** Harnesses the coordinator can log in (they have a broker method). */
function hasBrokerLogin(harnessId: HarnessId): boolean {
	return getBrokerLoginMethod(harnessId) !== undefined;
}

/**
 * Display name of a harness.
 *
 * @param harnessId - Harness id
 * @returns e.g. "Claude Code"
 */
function displayName(harnessId: HarnessId): string {
	return getHarnessDefinition(harnessId)?.displayName ?? harnessId;
}

/**
 * Whether a reply asks to start the login over.
 *
 * @param text - Owner reply
 * @returns True for `relogin`, `re-login` or `重新登录`
 */
export function isRetryKeyword(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return HARNESS_CONSTANTS.RELOGIN.RETRY_KEYWORDS.some((keyword) => keyword.toLowerCase() === normalized);
}

/**
 * Strip formatting Slack clients add around a pasted value (backticks).
 *
 * @param text - Owner reply
 * @returns The bare value, trimmed
 */
export function unwrapReply(text: string): string {
	return text.trim().replace(/^`+|`+$/g, '').trim();
}

/**
 * Whether a reply plausibly is Claude's authorization code: one token with
 * no whitespace and a plausible length.
 *
 * @param text - Unwrapped owner reply
 * @returns True when it can be typed into `claude setup-token`
 */
export function looksLikeAuthCode(text: string): boolean {
	const { CODE_MIN_LENGTH, CODE_MAX_LENGTH } = HARNESS_CONSTANTS.RELOGIN;
	return text.length >= CODE_MIN_LENGTH && text.length <= CODE_MAX_LENGTH && !/\s/.test(text);
}

/**
 * "2 agents are waiting: a, b" — capped list of waiting agents.
 *
 * @param agents - Session names
 * @returns Sentence fragment
 */
export function describeWaitingAgents(agents: readonly string[]): string {
	if (agents.length === 0) return 'No agent is running on it right now.';
	const max = HARNESS_CONSTANTS.RELOGIN.DM_MAX_LISTED_AGENTS;
	const listed = agents.slice(0, max).join(', ');
	const more = agents.length > max ? ` and ${agents.length - max} more` : '';
	const noun = agents.length === 1 ? '1 agent is' : `${agents.length} agents are`;
	return `${noun} waiting: ${listed}${more}.`;
}

/**
 * Keep text safe for a DM: redact secrets, drop code fences, cap length (tail).
 *
 * @param text - Screen or message text
 * @param max - Maximum length
 * @returns Safe text
 */
function safeForDm(text: string, max: number): string {
	const redacted = redactSecrets(text).replace(/```/g, "'''").trim();
	return redacted.length > max ? redacted.slice(redacted.length - max) : redacted;
}

/** Retry hint appended to failure DMs. */
const RETRY_HINT = 'Reply `relogin` (or `重新登录`) here to try again.';

/**
 * DM with the sign-in link (and Codex's one-time code on its own line).
 *
 * @param session - Broker session (never contains a secret)
 * @param waiting - Agents waiting on the login
 * @returns Slack mrkdwn text
 */
export function formatLinkDm(session: LoginSession, waiting: readonly string[]): string {
	const name = displayName(session.harnessId);
	const lines = [`*${name} login expired.* ${describeWaitingAgents(waiting)}`, ''];
	if (session.method === 'device') {
		lines.push('1. Open this link on your phone:', session.url ?? '', '', '2. Enter this one-time code:', session.userCode ?? '', '');
		lines.push('Finish the login on your phone and it continues by itself.');
	} else {
		lines.push('1. Open this link on your phone and approve:', session.url ?? '', '');
		lines.push('2. Reply to this DM with the code shown after you approve (just the code).', '');
		lines.push('Crewly types it in and the agents continue by themselves.');
	}
	return lines.join('\n');
}

/**
 * DM for a login screen the broker did not recognise.
 *
 * @param session - Broker session
 * @param waiting - Agents waiting on the login
 * @returns Slack mrkdwn text
 */
export function formatScreenDm(session: LoginSession, waiting: readonly string[]): string {
	const screen = safeForDm(session.screen, HARNESS_CONSTANTS.RELOGIN.DM_SCREEN_MAX_CHARS) || '(empty screen)';
	return [
		`*${displayName(session.harnessId)} login expired.* ${describeWaitingAgents(waiting)}`,
		'',
		'Crewly started the login, but did not recognise its screen. This is what it shows:',
		'```',
		screen,
		'```',
		'Your next reply in this DM will be typed into that terminal.',
	].join('\n');
}

/**
 * DM after the harness rejected the owner's reply (e.g. a wrong code).
 *
 * @param session - Broker session (awaiting input again)
 * @returns Slack mrkdwn text
 */
export function formatRejectedDm(session: LoginSession): string {
	const reason = safeForDm(session.message ?? '', HARNESS_CONSTANTS.RELOGIN.DM_MESSAGE_MAX_CHARS);
	const what = session.method === 'subscription' ? 'code' : 'reply';
	return `That ${what} did not work${reason ? ` (${reason})` : ''}. Reply with the ${what} again, or ${RETRY_HINT.charAt(0).toLowerCase()}${RETRY_HINT.slice(1)}`;
}

/**
 * DM after the login succeeded and the agents were restarted.
 *
 * @param harnessId - Harness
 * @param result - Resume result
 * @returns Slack mrkdwn text
 */
export function formatSuccessDm(harnessId: HarnessId, result: { resumed: string[]; failed: string[] }): string {
	const count = result.resumed.length;
	let text = `Done: ${displayName(harnessId)} is logged in again, ${count} ${count === 1 ? 'agent' : 'agents'} resumed.`;
	if (result.failed.length > 0) {
		text += ` Could not restart: ${result.failed.join(', ')}.`;
	}
	return text;
}

/**
 * DM after the login failed or timed out (sent once per failure).
 *
 * @param harnessId - Harness
 * @param reason - Broker message (redacted here)
 * @returns Slack mrkdwn text
 */
export function formatFailureDm(harnessId: HarnessId, reason: string | null): string {
	const detail = safeForDm(reason ?? '', HARNESS_CONSTANTS.RELOGIN.DM_MESSAGE_MAX_CHARS);
	return `${displayName(harnessId)} login did not finish${detail ? `: ${detail}` : '.'} ${RETRY_HINT}`;
}

/** Coordinates Slack re-login flows, one per harness. */
export class HarnessReloginService {
	private readonly broker: ReloginBroker;
	private readonly credentials: HarnessReloginDeps['credentials'];
	private readonly apiKeys: HarnessReloginDeps['apiKeys'];
	private readonly checkLoginState: HarnessReloginDeps['checkLoginState'];
	private readonly getOrcHarness: HarnessReloginDeps['getOrcHarness'];
	private notifier: ReloginOwnerNotifier | null;
	private resumer: ReloginAgentResumer | null;
	private readonly now: () => number;
	private readonly logger: HarnessLogger;
	private readonly flows = new Map<HarnessId, ReloginFlow>();
	/** Expiry reports are ignored until then (resumed transcripts repeat old errors) */
	private readonly quietUntil = new Map<HarnessId, number>();
	/** Last silent API-key recovery per harness */
	private readonly silentKeyAt = new Map<HarnessId, number>();
	/** Sessions restarted after a login: screen-sweep reports are ignored until live output reports again */
	private readonly mutedScreens = new Set<string>();
	/** Harnesses the status check has seen logged in */
	private readonly seenLoggedIn = new Set<HarnessId>();
	private statusTimer: NodeJS.Timeout | null = null;
	private statusCheckInFlight = false;

	/**
	 * @param deps - Dependencies
	 */
	constructor(deps: HarnessReloginDeps) {
		this.broker = deps.broker;
		this.credentials = deps.credentials;
		this.apiKeys = deps.apiKeys;
		this.checkLoginState = deps.checkLoginState;
		this.getOrcHarness = deps.getOrcHarness;
		this.notifier = deps.notifier ?? null;
		this.resumer = deps.resumer ?? null;
		this.now = deps.now ?? Date.now;
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
		this.broker.on(LOGIN_BROKER_EVENTS.UPDATE, (session: LoginSession) => this.handleUpdate(session));
		this.broker.on(LOGIN_BROKER_EVENTS.FINISHED, (session: LoginSession) => this.handleFinished(session));
	}

	/**
	 * Set how the owner is DM'd (the Slack adapter; wired after Slack is up).
	 *
	 * @param notifier - Notifier, or null
	 */
	setNotifier(notifier: ReloginOwnerNotifier | null): void {
		this.notifier = notifier;
	}

	/**
	 * Set how agents are restarted after a login.
	 *
	 * @param resumer - Resumer, or null
	 */
	setResumer(resumer: ReloginAgentResumer | null): void {
		this.resumer = resumer;
	}

	/**
	 * Report an expired harness login.
	 *
	 * @param report - Which harness, which session, from where
	 * @returns True when the coordinator owns the harness's re-login (the
	 *   caller must not start its own `/login` or notice); false for a
	 *   harness Crewly cannot log in (no broker method)
	 */
	reportExpiry(report: ExpiryReport): boolean {
		const { harnessId, sessionName, source } = report;
		if (!hasBrokerLogin(harnessId)) return false;

		// Right after a login, resumed agents replay their old transcript
		// (including the old error): ignore every report for a while.
		if (this.now() < (this.quietUntil.get(harnessId) ?? 0)) return true;
		if (sessionName) {
			// A resumed session's screen can keep showing the old error: only
			// new live output counts for it again.
			if (source === 'screen' && this.mutedScreens.has(sessionName)) return true;
			if (source === 'output') this.mutedScreens.delete(sessionName);
		}

		const existing = this.flows.get(harnessId);
		if (existing) {
			if (sessionName) existing.stuck.add(sessionName);
			if (existing.phase === 'failed' && this.now() - (existing.lastDmAt ?? 0) >= HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS) {
				this.logger.info('Re-login: reminding the owner', { harnessId, source });
				this.restart(existing);
			}
			return true;
		}

		this.logger.warn('Harness login expired — starting a Slack re-login', { harnessId, sessionName, source });
		this.begin(harnessId, new Set(sessionName ? [sessionName] : []));
		return true;
	}

	/**
	 * Offer an owner's Slack DM reply to the re-login flows.
	 *
	 * @param text - Reply text (never logged)
	 * @returns True when consumed; the caller must then NOT pass it on as a chat message
	 */
	handleOwnerReply(text: string): boolean {
		if (typeof text !== 'string' || this.flows.size === 0) return false;

		if (isRetryKeyword(text)) {
			const flows = [...this.flows.values()];
			const failed = flows.filter((flow) => flow.phase === 'failed');
			const targets = failed.length > 0 ? failed : flows;
			for (const flow of targets) this.restart(flow);
			this.logger.info('Re-login restarted on the owner\'s request', { harnessIds: targets.map((flow) => flow.harnessId) });
			return true;
		}

		const reply = unwrapReply(text);
		for (const flow of this.flows.values()) {
			if (flow.phase !== 'running' || !flow.sessionId) continue;
			const session = this.readSession(flow.sessionId);
			if (!session || isTerminalLoginState(session.state)) continue;

			const takesCode =
				flow.dm === 'link' && session.method === 'subscription' && session.state === 'awaiting_user' && session.needsInput && looksLikeAuthCode(reply);
			const takesScreenReply =
				flow.dm === 'screen' && reply.length > 0 && reply.length <= HARNESS_CONSTANTS.RELOGIN.SCREEN_REPLY_MAX_LENGTH && !/[\r\n]/.test(reply);
			if (!takesCode && !takesScreenReply) continue;

			try {
				this.broker.input(flow.sessionId, reply);
				flow.replied = true;
				flow.lastRejection = null;
				this.logger.info('Owner reply typed into the login', { harnessId: flow.harnessId, sessionId: flow.sessionId });
			} catch (error) {
				// The session ended between the check and the input. The reply
				// looked like a code: still keep it out of the chat.
				this.logger.warn('Could not type the owner reply into the login', {
					harnessId: flow.harnessId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return true;
		}
		return false;
	}

	/**
	 * The pending re-login for a harness (shown by `GET /api/harness`).
	 *
	 * @param harnessId - Harness id
	 * @returns The pending re-login, or null when none is running
	 */
	getPending(harnessId: HarnessId): ReloginPending | null {
		const flow = this.flows.get(harnessId);
		if (!flow || flow.phase !== 'running' || !flow.sessionId) return null;
		return { harnessId, sessionId: flow.sessionId, startedAt: new Date(flow.startedAt).toISOString() };
	}

	/**
	 * Check the orchestrator's harness with its own status command, and
	 * report an expiry when it says logged out. Only a harness that was seen
	 * logged in, or that agents are running on, counts (a machine that was
	 * never logged in is onboarding's job, not a re-login).
	 *
	 * @returns Resolves when the check is done; never rejects
	 */
	async checkOrcHarness(): Promise<void> {
		if (this.statusCheckInFlight) return;
		this.statusCheckInFlight = true;
		try {
			const orc = await this.getOrcHarness();
			if (!isHarnessId(orc) || !hasBrokerLogin(orc)) return;
			const state = await this.checkLoginState(orc);
			if (state === 'logged_in') {
				this.seenLoggedIn.add(orc);
				return;
			}
			if (state !== 'logged_out') return;
			const running = this.resumer?.listSessions(orc) ?? [];
			if (!this.seenLoggedIn.has(orc) && running.length === 0) return;
			this.reportExpiry({ harnessId: orc, sessionName: null, source: 'status' });
		} catch (error) {
			this.logger.warn('Harness status check failed', { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.statusCheckInFlight = false;
		}
	}

	/**
	 * Start the periodic status check of the orchestrator's harness.
	 *
	 * @param intervalMs - Cadence (defaults to STATUS_CHECK_INTERVAL_MS)
	 */
	start(intervalMs: number = HARNESS_CONSTANTS.RELOGIN.STATUS_CHECK_INTERVAL_MS): void {
		if (this.statusTimer) return;
		this.statusTimer = setInterval(() => void this.checkOrcHarness(), intervalMs);
		this.statusTimer.unref?.();
	}

	/** Stop the periodic check and forget every flow's timers. */
	stop(): void {
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = null;
		for (const flow of this.flows.values()) this.clearScreenTimer(flow);
	}

	/**
	 * Start a flow: silent API key if Crewly holds one, else a broker login.
	 *
	 * @param harnessId - Harness
	 * @param stuck - Sessions known to be stuck
	 */
	private begin(harnessId: HarnessId, stuck: Set<string>): void {
		const flow: ReloginFlow = {
			harnessId,
			phase: 'running',
			sessionId: null,
			startedAt: this.now(),
			stuck,
			dm: 'none',
			lastDmAt: null,
			replied: false,
			lastRejection: null,
			screenTimer: null,
			cancelledByUs: false,
		};
		// Registered synchronously: this is the per-harness debounce.
		this.flows.set(harnessId, flow);
		void this.run(flow);
	}

	/**
	 * Body of a flow (async part of {@link begin}).
	 *
	 * @param flow - The flow
	 */
	private async run(flow: ReloginFlow): Promise<void> {
		if (await this.tryStoredApiKey(flow)) return;
		if (this.flows.get(flow.harnessId) !== flow) return;

		const method = getBrokerLoginMethod(flow.harnessId);
		if (!method) return;
		let session: LoginSession;
		try {
			session = this.broker.start(flow.harnessId, method.id);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.warn('Re-login: could not start the login', { harnessId: flow.harnessId, error: reason });
			flow.phase = 'failed';
			await this.dm(flow, formatFailureDm(flow.harnessId, `Crewly could not start it (${reason}).`));
			return;
		}
		flow.sessionId = session.id;
		flow.startedAt = Date.parse(session.startedAt) || this.now();
		flow.screenTimer = setTimeout(() => void this.sendScreenIfUnrecognised(flow), HARNESS_CONSTANTS.RELOGIN.UNRECOGNISED_SCREEN_MS);
		flow.screenTimer.unref?.();
		this.logger.info('Re-login broker session started', { harnessId: flow.harnessId, sessionId: session.id, method: method.id });
		// The broker may hand back a session that already shows its link.
		if (isTerminalLoginState(session.state)) this.handleFinished(session);
		else this.handleUpdate(session);
	}

	/**
	 * Use an API key Crewly holds for the harness, without asking the owner.
	 * Not repeated within SILENT_KEY_RETRY_WINDOW_MS: a key that did not
	 * help falls back to the phone login.
	 *
	 * @param flow - The flow
	 * @returns True when the key was used and the agents were resumed
	 */
	private async tryStoredApiKey(flow: ReloginFlow): Promise<boolean> {
		const { harnessId } = flow;
		const last = this.silentKeyAt.get(harnessId);
		if (last !== undefined && this.now() - last < HARNESS_CONSTANTS.RELOGIN.SILENT_KEY_RETRY_WINDOW_MS) return false;
		try {
			if (harnessId === HARNESS_CONSTANTS.IDS.CLAUDE_CODE) {
				// Agents get ANTHROPIC_API_KEY from the store when they are recreated.
				if (this.credentials.getClaudeCredentialKind() !== 'api_key') return false;
			} else if (harnessId === HARNESS_CONSTANTS.IDS.CODEX_CLI) {
				const key = this.credentials.read().codex?.openaiApiKey;
				if (!key) return false;
				await this.apiKeys.submit(harnessId, key);
			} else {
				return false;
			}
		} catch (error) {
			this.logger.warn('Re-login: the stored API key did not work, asking the owner instead', {
				harnessId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		this.silentKeyAt.set(harnessId, this.now());
		this.logger.info('Re-login: using the stored API key', { harnessId });
		await this.succeed(flow, false);
		return true;
	}

	/**
	 * Broker update: send the link once it is complete, report a rejected reply.
	 *
	 * @param session - Session snapshot
	 */
	private handleUpdate(session: LoginSession): void {
		const flow = this.flows.get(session.harnessId);
		if (!flow || flow.phase !== 'running' || flow.sessionId !== session.id || isTerminalLoginState(session.state)) return;

		const linkReady = session.method === 'device' ? Boolean(session.url && session.userCode) : Boolean(session.url);
		if (flow.dm !== 'link' && linkReady) {
			flow.dm = 'link';
			this.clearScreenTimer(flow);
			void this.dm(flow, formatLinkDm(session, this.waitingAgents(flow)));
			return;
		}

		if (flow.replied && session.state === 'awaiting_user' && session.message && session.message !== flow.lastRejection) {
			flow.lastRejection = session.message;
			flow.replied = false;
			void this.dm(flow, formatRejectedDm(session));
		}
	}

	/**
	 * Broker session finished.
	 *
	 * @param session - Final snapshot
	 */
	private handleFinished(session: LoginSession): void {
		const flow = this.flows.get(session.harnessId);
		if (!flow) return;
		if (flow.sessionId !== session.id) {
			// The owner logged in another way (web / phone app) while a flow waited.
			if (session.state === 'succeeded') {
				this.clearScreenTimer(flow);
				this.cancelOwnSession(flow);
				void this.succeed(flow, true);
			}
			return;
		}
		if (flow.phase !== 'running') return;
		this.clearScreenTimer(flow);

		if (session.state === 'succeeded') {
			void this.succeed(flow, true);
			return;
		}
		flow.phase = 'failed';
		if (flow.cancelledByUs) return;
		if (session.state === 'cancelled') {
			// Cancelled on the web or by a shutdown: the owner knows; stay quiet.
			this.logger.info('Re-login cancelled', { harnessId: flow.harnessId, sessionId: session.id });
			return;
		}
		this.logger.warn('Re-login did not finish', { harnessId: flow.harnessId, sessionId: session.id, state: session.state });
		void this.dm(flow, formatFailureDm(flow.harnessId, session.message));
	}

	/**
	 * The login is back: restart the stuck agents and tell the owner.
	 *
	 * @param flow - The flow
	 * @param notify - DM the owner (false for the silent API-key path)
	 */
	private async succeed(flow: ReloginFlow, notify: boolean): Promise<void> {
		if (this.flows.get(flow.harnessId) === flow) this.flows.delete(flow.harnessId);
		this.quietUntil.set(flow.harnessId, this.now() + HARNESS_CONSTANTS.RELOGIN.POST_SUCCESS_QUIET_MS);
		this.seenLoggedIn.add(flow.harnessId);

		const sessions = this.waitingAgents(flow);
		let result: { resumed: string[]; failed: string[] } = { resumed: [], failed: [] };
		if (this.resumer && sessions.length > 0) {
			try {
				result = await this.resumer.resume(sessions);
			} catch (error) {
				this.logger.warn('Re-login: resuming agents failed', { error: error instanceof Error ? error.message : String(error) });
				result = { resumed: [], failed: [...sessions] };
			}
		}
		for (const name of result.resumed) this.mutedScreens.add(name);
		this.logger.info('Re-login finished', { harnessId: flow.harnessId, resumed: result.resumed.length, failed: result.failed.length });
		if (notify) await this.dm(flow, formatSuccessDm(flow.harnessId, result));
	}

	/**
	 * Start a flow over (retry keyword or re-reminder).
	 *
	 * @param flow - The flow to replace
	 */
	private restart(flow: ReloginFlow): void {
		this.clearScreenTimer(flow);
		this.cancelOwnSession(flow);
		if (this.flows.get(flow.harnessId) === flow) this.flows.delete(flow.harnessId);
		this.begin(flow.harnessId, new Set(flow.stuck));
	}

	/**
	 * Cancel the flow's live broker session, marking it as cancelled by the
	 * coordinator so no failure DM is sent for it.
	 *
	 * @param flow - The flow
	 */
	private cancelOwnSession(flow: ReloginFlow): void {
		if (flow.phase !== 'running' || !flow.sessionId) return;
		flow.cancelledByUs = true;
		try {
			this.broker.cancel(flow.sessionId);
		} catch {
			// Already gone.
		}
	}

	/**
	 * After UNRECOGNISED_SCREEN_MS without a link: send the screen as-is.
	 *
	 * @param flow - The flow
	 */
	private async sendScreenIfUnrecognised(flow: ReloginFlow): Promise<void> {
		flow.screenTimer = null;
		if (this.flows.get(flow.harnessId) !== flow || flow.phase !== 'running' || flow.dm !== 'none' || !flow.sessionId) return;
		const session = this.readSession(flow.sessionId);
		if (!session || isTerminalLoginState(session.state)) return;
		flow.dm = 'screen';
		this.logger.warn('Re-login: login screen not recognised, sending it to the owner', { harnessId: flow.harnessId, sessionId: session.id });
		await this.dm(flow, formatScreenDm(session, this.waitingAgents(flow)));
	}

	/**
	 * Agents waiting on a flow: the stuck ones, else every session of the harness.
	 *
	 * @param flow - The flow
	 * @returns Session names
	 */
	private waitingAgents(flow: ReloginFlow): string[] {
		if (flow.stuck.size > 0) return [...flow.stuck];
		try {
			return this.resumer?.listSessions(flow.harnessId) ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * DM the owner (logs when no notifier is wired; never logs the text).
	 *
	 * @param flow - The flow
	 * @param text - DM text
	 */
	private async dm(flow: ReloginFlow, text: string): Promise<void> {
		flow.lastDmAt = this.now();
		if (!this.notifier) {
			this.logger.warn('Re-login: no Slack DM path to the owner; finish the login from Setup', { harnessId: flow.harnessId });
			return;
		}
		try {
			const delivered = await this.notifier.sendToOwner(text);
			if (!delivered) this.logger.warn('Re-login: the owner DM was not delivered', { harnessId: flow.harnessId });
		} catch (error) {
			this.logger.warn('Re-login: sending the owner DM failed', {
				harnessId: flow.harnessId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Read a broker session.
	 *
	 * @param sessionId - Session id
	 * @returns The session, or null when the broker forgot it
	 */
	private readSession(sessionId: string): LoginSession | null {
		try {
			return this.broker.get(sessionId);
		} catch {
			return null;
		}
	}

	/**
	 * Clear a flow's unrecognised-screen timer.
	 *
	 * @param flow - The flow
	 */
	private clearScreenTimer(flow: ReloginFlow): void {
		if (flow.screenTimer) clearTimeout(flow.screenTimer);
		flow.screenTimer = null;
	}
}

/** Backend singleton. */
let instance: HarnessReloginService | null = null;

/**
 * The backend's re-login coordinator, bound to the backend harness service
 * (its broker, credentials, API keys and status). Registers itself as the
 * `reloginPending` source of `GET /api/harness`.
 *
 * @returns The singleton
 */
export function getHarnessReloginService(): HarnessReloginService {
	if (!instance) {
		const harness = getHarnessService();
		const service = new HarnessReloginService({
			broker: harness.broker,
			credentials: getHarnessCredentialsStore(),
			apiKeys: harness.apiKeys,
			checkLoginState: async (harnessId) => {
				const def = getHarnessDefinition(harnessId);
				if (!def) return 'unknown';
				const installed = await harness.status.getInstalledInfo(def);
				if (!installed.installed) return 'unknown';
				return (await harness.status.getLoginInfo(def, installed.path)).loginState;
			},
			getOrcHarness: () => harness.orc.get(),
			logger: LoggerService.getInstance().createComponentLogger('HarnessRelogin'),
		});
		harness.setReloginPendingProvider((harnessId) => service.getPending(harnessId));
		instance = service;
	}
	return instance;
}

/**
 * Replace or clear the singleton (tests).
 *
 * @param service - Service, or null
 */
export function setHarnessReloginServiceForTesting(service: HarnessReloginService | null): void {
	instance?.stop();
	instance = service;
}

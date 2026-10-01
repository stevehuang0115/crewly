/**
 * Harness re-login coordinator — re-login from the owner's phone, with no
 * agent involved.
 *
 * The instance backend (never an agent: every agent may be stuck on the very
 * login that expired) notices that a harness's login is gone, tells the owner
 * once, runs the harness's login itself when the owner replies, relays the
 * link and the code, and brings the agents back with the messages that
 * waited for them.
 *
 * Flow per harness (at most one at a time):
 *
 * 1. **Detect.** {@link HarnessReloginService.reportExpiry} — an agent's
 *    output or screen matched an expiry rule (login-expiry-rules.ts, via the
 *    OAuth re-login monitor), or the periodic check
 *    ({@link HarnessReloginService.checkHarnesses}) found a harness in use
 *    signed out. The periodic check covers every harness the orchestrator or
 *    a team member is configured on, so it works with zero agents running.
 * 2. **Confirm.** The harness's status command, then — because Claude Code's
 *    stored credential survives an expiry — a live probe
 *    (harness-login-probe.ts). Only a confirmed `logged_out` goes on;
 *    `unknown` never does (`codex login` revokes a working login).
 * 3. **Tell the owner once.** A stored API key is used silently if Crewly has
 *    one. Otherwise one DM — "Claude Code on <machine> is signed out, so N
 *    agents can't work. Reply `login` …" — then re-reminders with backoff
 *    (3 h, doubling, 24 h cap), persisted so restarts do not re-send it. No
 *    login is started yet: a link sent while the owner is away expires unused.
 * 4. **The owner replies `login`** (or 「重新登录」, `relogin claude`, …) in
 *    the DM. The Slack bridge offers owner DMs to
 *    {@link HarnessReloginService.handleOwnerReply} before anything else, so
 *    this works with no agent awake. The login broker runs the harness's
 *    login in its own PTY (`claude setup-token` / `codex login --device-auth`)
 *    and the link (and Codex's one-time code) is sent back.
 * 5. **The code.** For Claude the owner replies with the code from the page;
 *    it is typed into the waiting login. A rejected code is reported once; an
 *    expired link puts the flow back to "signed out" ("reply `login` for a
 *    new link").
 * 6. **Success** is confirmed with the probe, then the stuck agents are
 *    restarted (conversation resumed) and the owner messages that waited are
 *    re-delivered ({@link HarnessReloginDeps.onLoginRestored}). One DM says so.
 *
 * Owner-requested logins ({@link HarnessReloginService.startOwnerLogin}:
 * 「重新登录 claude」 / "relogin codex" / the orchestrator's `harness-login`
 * skill) start the broker at once, even while logged in (account switch).
 *
 * Secrets: Claude's code is passed to the broker and never stored, logged
 * or echoed; DMs are built from {@link LoginSession} snapshots, which never
 * contain a token, and the screen text is redacted again.
 *
 * @module services/harness/harness-relogin.service
 */

import * as os from 'os';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { HarnessApiKeyService } from './harness-api-key.service.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from './harness-credentials.store.js';
import { createHarnessLoginProbe } from './harness-login-probe.js';
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
import { parseOwnerLoginRequest, type OwnerLoginRequest } from './owner-login-request.js';
import { MemoryReloginStateStore, createDefaultReloginStateStore, type ReloginStateStore } from './relogin-state.store.js';

/** Where an expiry report came from. */
export type ExpirySource = 'output' | 'screen' | 'status';

/** An expired-login report. */
export interface ExpiryReport {
	harnessId: HarnessId;
	/** Agent session whose output matched, or null when unknown (status check) */
	sessionName: string | null;
	/**
	 * `output`: a live PTY chunk; `screen`: the periodic screen sweep (may show
	 * old scrollback); `status`: the harness's own status command or probe
	 */
	source: ExpirySource;
}

/**
 * A Slack conversation (and thread) to answer in. `agentSession` is set when
 * that conversation is a DM with an agent's own bot (the orc's "Crewly Orc"
 * app), whose token must be used to post there.
 */
export interface ReloginReplyTarget {
	channelId: string;
	threadTs?: string;
	agentSession?: string;
}

/**
 * Result of a DM: false when nothing was delivered; true, or the
 * conversation it landed in (so a code reply can be matched to it).
 */
export type ReloginDelivery = boolean | ReloginReplyTarget;

/** Sends a Slack DM to the owner. */
export interface ReloginOwnerNotifier {
	/**
	 * Send a DM to the owner.
	 *
	 * @param text - Slack mrkdwn text (never contains a secret)
	 * @param target - Conversation to answer in; absent = this machine's own DM with the owner
	 * @returns Where it was delivered (or true), false when it was not
	 */
	sendToOwner(text: string, target?: ReloginReplyTarget | null): Promise<ReloginDelivery>;
	/**
	 * Whether a DM can be sent right now (Slack connected).
	 *
	 * @returns True when {@link sendToOwner} can deliver
	 */
	isAvailable?(): boolean;
}

/** What started a flow. */
export type ReloginTrigger = 'expiry' | 'owner';

/** Where an owner reply was written: the orc's / master DM, or another agent's bot DM. */
export type OwnerReplyScope = 'orc' | 'agent';

/** Options of an owner-requested login. */
export interface OwnerLoginOptions {
	/** The owner wants a different account (only changes the wording) */
	switchAccount?: boolean;
	/** Conversation to answer in (null = this machine's DM with the owner) */
	replyTarget?: ReloginReplyTarget | null;
	/** Who relayed the request, for logs */
	requestedBy: 'owner_dm' | 'orchestrator';
}

/** An owner-requested login that was started. */
export interface OwnerLoginStarted {
	/** `restarted`: a flow for the harness was running and was started over */
	status: 'started' | 'restarted';
	harnessId: HarnessId;
	/** Whether the owner can be DM'd right now (false = Slack is down) */
	dmAvailable: boolean;
}

/** An owner-requested login for a harness without a link login. */
export interface OwnerLoginUnsupported {
	/** The harness has no link login (Antigravity: API key; Gemini: enterprise only) */
	status: 'no_broker_login';
	harnessId: HarnessId;
	/** What to tell the owner */
	message: string;
}

/** Result of {@link HarnessReloginService.startOwnerLogin}. */
export type OwnerLoginResult = OwnerLoginStarted | OwnerLoginUnsupported;

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

/** An agent configured on this machine (running or not). */
export interface ConfiguredAgent {
	sessionName: string;
	/** Runtime type (= harness id for the harnesses Crewly can log in) */
	harnessId: string;
	/** Name the owner knows ("Ella") */
	displayName?: string;
}

/** The slice of the login broker the coordinator uses. */
export type ReloginBroker = Pick<LoginBrokerService, 'start' | 'get' | 'input' | 'cancel' | 'on'>;

/** Injectable dependencies. */
export interface HarnessReloginDeps {
	broker: ReloginBroker;
	credentials: Pick<HarnessCredentialsStore, 'read' | 'getClaudeCredentialKind'>;
	apiKeys: Pick<HarnessApiKeyService, 'submit'>;
	/** The harness's login state from its own status command (cheap; a stored Claude credential reads as logged in) */
	checkLoginState: (harnessId: HarnessId) => Promise<LoginState>;
	/**
	 * Live sign-in probe (harness-login-probe.ts): `logged_out` / `logged_in`
	 * when it could tell, `unknown` otherwise. Absent = status only.
	 */
	verifyLogin?: (harnessId: HarnessId) => Promise<LoginState>;
	/** The orchestrator's harness (null before setup recorded one) */
	getOrcHarness: () => Promise<string | null>;
	/** Every agent configured on this machine, running or not (orc included) */
	listAgents?: () => Promise<ConfiguredAgent[]>;
	/** Whether a live agent session is sitting at a sign-in screen (OAuth monitor flag) */
	sessionNeedsLogin?: (sessionName: string) => boolean;
	/**
	 * After a login came back and the agents were restarted: re-deliver what
	 * waited for them (owner-message watchdog). Returns how many messages.
	 */
	onLoginRestored?: (harnessId: HarnessId, resumed: readonly string[]) => Promise<number> | number;
	/** This machine's name, for the owner ("iriss-air.lan") */
	machineName?: () => string;
	/** Persisted notice / backoff state */
	state?: ReloginStateStore;
	notifier?: ReloginOwnerNotifier | null;
	resumer?: ReloginAgentResumer | null;
	now?: () => number;
	logger?: HarnessLogger;
}

/** One re-login flow (at most one per harness). */
interface ReloginFlow {
	harnessId: HarnessId;
	/**
	 * `signed_out`: confirmed signed out (or a login ended without success),
	 * waiting for the owner's `login`; `running`: a broker session is live
	 */
	phase: 'signed_out' | 'running';
	sessionId: string | null;
	startedAt: number;
	/** Sessions whose output matched */
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
	/** `owner`: the owner asked (forced); `expiry`: detected */
	trigger: ReloginTrigger;
	/** Owner asked for a different account (wording only) */
	switchAccount: boolean;
	/** Where DMs go (null = this machine's DM with the owner) */
	replyTarget: ReloginReplyTarget | null;
	/** Channel the link / screen was delivered in: a code is only taken from there */
	linkChannelId: string | null;
	/** How the last broker session ended (null while running / never ran) */
	lastOutcome: LoginSession['state'] | null;
	/** Re-remind the owner with backoff while signed out (expiry flows) */
	remind: boolean;
	/** On success restart every live session of the harness (false: only the stuck ones) */
	restartAll: boolean;
}

/** Options a flow is started with. */
interface FlowOptions {
	trigger: ReloginTrigger;
	switchAccount: boolean;
	replyTarget: ReloginReplyTarget | null;
}

/** A detected expiry: not forced, standard wording, this machine's DM. */
const EXPIRY_FLOW: FlowOptions = { trigger: 'expiry', switchAccount: false, replyTarget: null };

/** Harnesses the coordinator can log in (they have a broker method). */
function hasBrokerLogin(harnessId: string): harnessId is HarnessId {
	return isHarnessId(harnessId) && getBrokerLoginMethod(harnessId) !== undefined;
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
 * The word the owner types after `relogin` for a harness.
 *
 * @param harnessId - Harness id
 * @returns e.g. "claude"
 */
export function harnessCommandWord(harnessId: HarnessId): string {
	if (harnessId === HARNESS_CONSTANTS.IDS.CLAUDE_CODE) return 'claude';
	if (harnessId === HARNESS_CONSTANTS.IDS.CODEX_CLI) return 'codex';
	if (harnessId === HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI) return 'antigravity';
	return 'gemini';
}

/**
 * Normalise a short reply for keyword matching: trim, lower-case, drop
 * surrounding quotes / backticks and trailing punctuation.
 *
 * @param text - Owner reply
 * @returns Normalised text
 */
function normaliseKeyword(text: string): string {
	return text
		.trim()
		.replace(/^[`'"「“]+|[`'"」”]+$/g, '')
		.replace(/[\s.!?。！？~～]+$/u, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

/**
 * Whether a reply asks to start the login over.
 *
 * @param text - Owner reply
 * @returns True for `relogin`, `re-login` or `重新登录`
 */
export function isRetryKeyword(text: string): boolean {
	const normalized = normaliseKeyword(text);
	return HARNESS_CONSTANTS.RELOGIN.RETRY_KEYWORDS.some((keyword) => keyword.toLowerCase() === normalized);
}

/**
 * Whether a bare reply asks to sign in (`login`, `sign in`, 「登录」, the retry keywords).
 *
 * @param text - Owner reply
 * @returns True when the whole reply is a login keyword
 *
 * @example
 * ```ts
 * isLoginKeyword('Login!'); // true
 * isLoginKeyword('login to gmail'); // false
 * ```
 */
export function isLoginKeyword(text: string): boolean {
	if (typeof text !== 'string') return false;
	const normalized = normaliseKeyword(text);
	return [...HARNESS_CONSTANTS.RELOGIN.LOGIN_KEYWORDS, ...HARNESS_CONSTANTS.RELOGIN.RETRY_KEYWORDS].some(
		(keyword) => keyword.toLowerCase() === normalized,
	);
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
 * "Ella, Rex and 3 more" — capped list of agent names.
 *
 * @param agents - Agent names
 * @returns List text ('' when empty)
 */
export function describeWaitingAgents(agents: readonly string[]): string {
	if (agents.length === 0) return '';
	const max = HARNESS_CONSTANTS.RELOGIN.DM_MAX_LISTED_AGENTS;
	const listed = agents.slice(0, max).join(', ');
	return agents.length > max ? `${listed} and ${agents.length - max} more` : listed;
}

/**
 * "1 agent" / "3 agents".
 *
 * @param n - Count
 * @returns Phrase
 */
function agentCount(n: number): string {
	return `${n} agent${n === 1 ? '' : 's'}`;
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
const RETRY_HINT = 'Reply `login` to try again.';

/**
 * Prefix an owner reply needs before it is typed into an unrecognised login
 * screen. Without it, any one-line DM to the orc during the login would have
 * been swallowed by the terminal.
 */
export const SCREEN_REPLY_PREFIXES = ['输入', 'input'] as const;

/**
 * The text after a screen-reply prefix ("input 1" → "1"), or null.
 *
 * @param reply - Owner reply (already unwrapped)
 * @returns Text to type, or null when the reply has no prefix
 */
export function stripScreenReplyPrefix(reply: string): string | null {
	for (const prefix of SCREEN_REPLY_PREFIXES) {
		const re = new RegExp(`^${prefix}[\\s:：]+`, 'i');
		if (re.test(reply)) return reply.replace(re, '');
	}
	return null;
}

/** How a link DM introduces the login. */
export interface LoginDmWording {
	/** The owner asked for this login (not an expiry) — kept for callers; the header is the same */
	ownerRequested?: boolean;
	/** The owner asked for a different account */
	switchAccount?: boolean;
	/** This machine's name */
	machine?: string;
}

/**
 * First line of a link DM.
 *
 * @param harnessId - Harness
 * @param wording - Account switch / machine
 * @returns Slack mrkdwn line
 */
function loginDmHeader(harnessId: HarnessId, wording: LoginDmWording): string {
	const name = displayName(harnessId);
	const where = wording.machine ? ` on ${wording.machine}` : '';
	return wording.switchAccount ? `*Switch the ${name} account${where}*` : `*Sign in to ${name}${where}*`;
}

/**
 * The first "signed out" DM, a re-reminder, or the note after a link expired unused.
 *
 * @param harnessId - Harness
 * @param machine - This machine's name
 * @param agents - Names of the agents that run on it
 * @param kind - `notice` (first), `reminder`, or `link_expired`
 * @returns Slack mrkdwn text
 *
 * @example
 * ```ts
 * formatSignedOutDm('claude-code', 'iriss-air.lan', ['Ella', 'Rex'], 'notice');
 * // "*Claude Code on iriss-air.lan is signed out*, so 2 agents can't work (Ella, Rex).\nReply `login` …"
 * ```
 */
export function formatSignedOutDm(
	harnessId: HarnessId,
	machine: string,
	agents: readonly string[],
	kind: 'notice' | 'reminder' | 'link_expired' = 'notice',
): string {
	const name = displayName(harnessId);
	const reply = `Reply \`login\` here to sign in from your phone (or \`relogin ${harnessCommandWord(harnessId)}\`).`;
	const listed = describeWaitingAgents(agents);
	const who = agents.length > 0 ? `, so ${agentCount(agents.length)} can't work (${listed})` : '';
	if (kind === 'link_expired') {
		return `The sign-in link for ${name} on ${machine} expired before it was used${agents.length > 0 ? `; ${agentCount(agents.length)} still waiting` : ''}. Reply \`login\` when you're ready and I'll send a fresh one (it works for 15 minutes).`;
	}
	if (kind === 'reminder') return `Reminder: ${name} on ${machine} is still signed out${who}.\n${reply}`;
	return `*${name} on ${machine} is signed out*${who}.\n${reply}`;
}

/**
 * DM with the sign-in link (and Codex's one-time code on its own line).
 *
 * @param session - Broker session (never contains a secret)
 * @param _waiting - Agents waiting on the login (unused; kept for callers)
 * @param wording - Account switch / machine
 * @returns Slack mrkdwn text
 */
export function formatLinkDm(session: LoginSession, _waiting: readonly string[] = [], wording: LoginDmWording = {}): string {
	const lines = [loginDmHeader(session.harnessId, wording), ''];
	if (session.method === 'device') {
		lines.push('1. Open this link on your phone:', session.url ?? '', '', '2. Enter this code:', session.userCode ?? '', '');
		if (wording.switchAccount) lines.push('To use a different account, switch to it on that page first.');
		lines.push('Finish signing in on your phone; Crewly continues by itself.');
	} else {
		lines.push('1. Open this link on your phone and approve:', session.url ?? '', '');
		if (wording.switchAccount) lines.push('   To use a different account, switch to it on that page before approving.', '');
		lines.push('2. Reply here with the code the page shows (just the code).', '');
		lines.push('The link works for 15 minutes. Crewly enters the code and the agents carry on.');
	}
	return lines.join('\n');
}

/**
 * DM for a login screen the broker did not recognise.
 *
 * @param session - Broker session
 * @param _waiting - Agents waiting on the login (unused; kept for callers)
 * @param wording - Account switch / machine
 * @returns Slack mrkdwn text
 */
export function formatScreenDm(session: LoginSession, _waiting: readonly string[] = [], wording: LoginDmWording = {}): string {
	const screen = safeForDm(session.screen, HARNESS_CONSTANTS.RELOGIN.DM_SCREEN_MAX_CHARS) || '(empty screen)';
	return [
		loginDmHeader(session.harnessId, wording),
		'',
		"Crewly started the sign-in but doesn't recognise its screen. It shows:",
		'```',
		screen,
		'```',
		'To type into it, reply `input <text>` (for example `input 1`). Other messages go to the Orc as usual.',
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
	const what = session.method === 'subscription' ? 'code' : 'input';
	return `That ${what} didn't work${reason ? ` (${reason})` : ''}. Reply with it again, or reply \`login\` for a fresh link.`;
}

/**
 * "; 2 waiting messages re-delivered".
 *
 * @param redelivered - Count
 * @returns Clause ('' for none)
 */
function redeliveredClause(redelivered: number): string {
	if (redelivered <= 0) return '';
	return `; ${redelivered} waiting message${redelivered === 1 ? '' : 's'} re-delivered`;
}

/**
 * DM after a login came back and the agents were restarted.
 *
 * @param harnessId - Harness
 * @param result - Resume result
 * @param redelivered - Owner messages re-delivered to them
 * @param machine - This machine's name
 * @returns Slack mrkdwn text
 */
export function formatSuccessDm(
	harnessId: HarnessId,
	result: { resumed: string[]; failed: string[] },
	redelivered: number = 0,
	machine?: string,
): string {
	const where = machine ? ` on ${machine}` : '';
	let text = `Done: ${displayName(harnessId)}${where} is signed in again. ${agentCount(result.resumed.length)} resumed${redeliveredClause(redelivered)}.`;
	if (result.failed.length > 0) text += ` Could not restart: ${result.failed.join(', ')}.`;
	return text;
}

/**
 * One-line DM after an owner-requested login succeeded.
 *
 * @param harnessId - Harness
 * @param result - Which agents were restarted onto the new login
 * @param redelivered - Owner messages re-delivered to them
 * @returns Slack mrkdwn text
 */
export function formatOwnerSuccessDm(harnessId: HarnessId, result: { resumed: string[]; failed: string[] }, redelivered: number = 0): string {
	let text = `Done: ${displayName(harnessId)} is signed in.`;
	if (result.resumed.length > 0) text += ` ${agentCount(result.resumed.length)} restarted on the new login${redeliveredClause(redelivered)}.`;
	if (result.failed.length > 0) text += ` Could not restart: ${result.failed.join(', ')}.`;
	return text;
}

/** Harness names the owner can type, for the "which one?" reply. */
const WHICH_HARNESS_HINT = 'Reply `relogin claude` or `relogin codex` (to switch accounts: `switch claude account`).';

/**
 * Reply to a login request that named no harness Crewly can log in.
 *
 * @param name - What the owner wrote, or null when they named none
 * @returns Slack mrkdwn text
 */
export function formatWhichHarnessDm(name: string | null): string {
	return name ? `Crewly doesn't run "${name}". Which one should I sign in? ${WHICH_HARNESS_HINT}` : `Which one should I sign in? ${WHICH_HARNESS_HINT}`;
}

/**
 * Reply for a harness that has no link login.
 *
 * @param harnessId - Harness without a broker login method
 * @returns Slack mrkdwn text
 */
export function formatNoBrokerLoginDm(harnessId: HarnessId): string {
	const name = displayName(harnessId);
	if (harnessId === HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI) {
		return `${name} uses a Gemini API key, not a sign-in link. Run \`crewly login antigravity\` on the machine, or enter the key in Crewly Setup → Sign in.`;
	}
	if (harnessId === HARNESS_CONSTANTS.IDS.GEMINI_CLI) {
		return `${name} is enterprise-only; Crewly can't sign it in. ${WHICH_HARNESS_HINT}`;
	}
	return `${name} has no sign-in link Crewly can use. ${WHICH_HARNESS_HINT}`;
}

/**
 * DM after the login failed (sent once per failure).
 *
 * @param harnessId - Harness
 * @param reason - Broker message (redacted here)
 * @returns Slack mrkdwn text
 */
export function formatFailureDm(harnessId: HarnessId, reason: string | null): string {
	const detail = safeForDm(reason ?? '', HARNESS_CONSTANTS.RELOGIN.DM_MESSAGE_MAX_CHARS);
	const clause = detail ? `: ${detail.replace(/[.!?。！？]+$/u, '')}.` : '.';
	return `Signing in to ${displayName(harnessId)} didn't finish${clause} ${RETRY_HINT}`;
}

/**
 * Re-reminder text for a login whose last link expired unused.
 *
 * @param harnessId - Harness
 * @param waiting - Agents waiting on the login
 * @param machine - This machine's name
 * @returns DM text
 */
export function formatReminderDm(harnessId: HarnessId, waiting: readonly string[], machine: string = os.hostname()): string {
	return formatSignedOutDm(harnessId, machine, waiting, 'link_expired');
}

/** Coordinates re-login flows, one per harness. */
export class HarnessReloginService {
	private readonly broker: ReloginBroker;
	private readonly credentials: HarnessReloginDeps['credentials'];
	private readonly apiKeys: HarnessReloginDeps['apiKeys'];
	private readonly checkLoginState: HarnessReloginDeps['checkLoginState'];
	private readonly verifyLogin: HarnessReloginDeps['verifyLogin'] | null;
	private readonly getOrcHarness: HarnessReloginDeps['getOrcHarness'];
	private listAgents: HarnessReloginDeps['listAgents'] | null;
	private sessionNeedsLogin: HarnessReloginDeps['sessionNeedsLogin'] | null;
	private onLoginRestored: HarnessReloginDeps['onLoginRestored'] | null;
	private readonly machineName: () => string;
	private readonly state: ReloginStateStore;
	private notifier: ReloginOwnerNotifier | null;
	private resumer: ReloginAgentResumer | null;
	private readonly now: () => number;
	private readonly logger: HarnessLogger;
	private readonly flows = new Map<HarnessId, ReloginFlow>();
	/** Harnesses whose expiry is being confirmed → sessions reported meanwhile */
	private readonly confirming = new Map<HarnessId, Set<string>>();
	/** Harnesses whose re-reminder is being prepared */
	private readonly reminding = new Set<HarnessId>();
	/** Expiry reports are ignored until then (resumed transcripts repeat old errors) */
	private readonly quietUntil = new Map<HarnessId, number>();
	/** Last silent API-key recovery per harness */
	private readonly silentKeyAt = new Map<HarnessId, number>();
	/** Sessions restarted after a login: screen-sweep reports are ignored until live output reports again */
	private readonly mutedScreens = new Set<string>();
	/** Last probe result per harness */
	private readonly probeCache = new Map<HarnessId, { at: number; state: LoginState }>();
	/** Probes in flight per harness */
	private readonly probeInFlight = new Map<HarnessId, Promise<LoginState>>();
	/** Agents configured on this machine, from the last {@link listAgents} */
	private agents: ConfiguredAgent[] = [];
	private statusTimer: NodeJS.Timeout | null = null;
	private firstCheckTimer: NodeJS.Timeout | null = null;
	private statusCheckInFlight = false;

	/**
	 * @param deps - Dependencies
	 */
	constructor(deps: HarnessReloginDeps) {
		this.broker = deps.broker;
		this.credentials = deps.credentials;
		this.apiKeys = deps.apiKeys;
		this.checkLoginState = deps.checkLoginState;
		this.verifyLogin = deps.verifyLogin ?? null;
		this.getOrcHarness = deps.getOrcHarness;
		this.listAgents = deps.listAgents ?? null;
		this.sessionNeedsLogin = deps.sessionNeedsLogin ?? null;
		this.onLoginRestored = deps.onLoginRestored ?? null;
		this.machineName = deps.machineName ?? (() => os.hostname());
		this.state = deps.state ?? new MemoryReloginStateStore();
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
	 * Set what re-delivers the owner messages that waited for a login.
	 *
	 * @param handler - Handler, or null
	 */
	setLoginRestoredHandler(handler: HarnessReloginDeps['onLoginRestored'] | null): void {
		this.onLoginRestored = handler ?? null;
	}

	/**
	 * Set how the configured agents (running or not) are listed.
	 *
	 * @param lister - Lister, or null
	 */
	setAgentLister(lister: HarnessReloginDeps['listAgents'] | null): void {
		this.listAgents = lister ?? null;
	}

	/**
	 * Set the per-session sign-in flag lookup (OAuth monitor).
	 *
	 * @param lookup - Lookup, or null
	 */
	setSessionNeedsLogin(lookup: HarnessReloginDeps['sessionNeedsLogin'] | null): void {
		this.sessionNeedsLogin = lookup ?? null;
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
		if (existing && (existing.phase === 'running' || existing.remind)) {
			if (sessionName) existing.stuck.add(sessionName);
			if (existing.phase === 'signed_out') void this.maybeRemind(existing);
			return true;
		}

		const confirming = this.confirming.get(harnessId);
		if (confirming) {
			if (sessionName) confirming.add(sessionName);
			return true;
		}

		// An owner flow that failed (e.g. an account switch) was not a confirmed
		// expiry; this report is — confirm it like any other.
		const stuck = new Set<string>(existing ? existing.stuck : []);
		if (sessionName) stuck.add(sessionName);
		this.confirming.set(harnessId, stuck);
		this.logger.warn('Harness login looks expired — confirming before telling the owner', { harnessId, sessionName, source });
		void this.confirmExpiry(harnessId);
		return true;
	}

	/**
	 * Offer an owner's Slack DM to the re-login coordinator.
	 *
	 * Consumed, in this order: a login keyword (`login`, 「重新登录」…) while a
	 * harness is signed out or signing in; a login code or screen reply for a
	 * running flow (only in the conversation the link went to); and finally an
	 * owner login request (「重新登录 claude」, "relogin codex" — see
	 * {@link parseOwnerLoginRequest}), which starts a forced login answered in
	 * `target`.
	 *
	 * In another agent's bot DM (`scope: 'agent'`) only a request that names a
	 * harness, or a reply to a flow, is taken — the rest is that agent's mail.
	 *
	 * @param text - Reply text (never logged)
	 * @param target - Conversation the owner wrote in (answers go there)
	 * @param scope - `orc` (orc / master DM) or `agent` (another agent's bot DM)
	 * @returns True when consumed; the caller must then NOT pass it on as a chat message
	 */
	handleOwnerReply(text: string, target: ReloginReplyTarget | null = null, scope: OwnerReplyScope = 'orc'): boolean {
		if (typeof text !== 'string') return false;
		if (this.flows.size > 0 && this.consumeFlowReply(text, target)) return true;

		// `login` in an agent's DM while that agent sits at a sign-in screen:
		// sign in its harness (the watchdog's note asks for exactly this).
		if (scope === 'agent' && isLoginKeyword(text) && target?.agentSession) {
			const harnessId = this.harnessOfSession(target.agentSession);
			if (harnessId && hasBrokerLogin(harnessId) && (this.isSignedOut(harnessId) || this.sessionNeedsLogin?.(target.agentSession))) {
				this.startOwnerLogin(harnessId, { replyTarget: target, requestedBy: 'owner_dm' });
				return true;
			}
		}

		const request = parseOwnerLoginRequest(text);
		if (!request) return false;
		if (scope === 'agent' && request.kind !== 'harness') return false;
		void this.handleOwnerLoginRequest(request, target);
		return true;
	}

	/**
	 * Start a login the owner asked for, through the broker: forced (runs
	 * even when the harness is still logged in — the owner may be switching
	 * accounts), no silent API key, answered in `replyTarget`. A flow already
	 * running for the harness is started over with a fresh link.
	 *
	 * @param harnessId - Harness to log in
	 * @param options - Account switch, reply target, who relayed the request
	 * @returns What happened (never throws)
	 */
	startOwnerLogin(harnessId: HarnessId, options: OwnerLoginOptions): OwnerLoginResult {
		if (!hasBrokerLogin(harnessId)) {
			return { status: 'no_broker_login', harnessId, message: formatNoBrokerLoginDm(harnessId) };
		}
		const existing = this.flows.get(harnessId);
		const restarted = Boolean(existing && existing.phase === 'running');
		this.logger.info('Owner-requested login started', {
			harnessId,
			requestedBy: options.requestedBy,
			switchAccount: options.switchAccount === true,
			restarted,
			answersInThread: Boolean(options.replyTarget),
		});
		this.replaceAndStart(harnessId, existing ?? null, {
			trigger: 'owner',
			switchAccount: options.switchAccount === true,
			replyTarget: options.replyTarget ?? existing?.replyTarget ?? null,
		});
		const dmAvailable = this.notifier ? (this.notifier.isAvailable?.() ?? true) : false;
		return { status: restarted ? 'restarted' : 'started', harnessId, dmAvailable };
	}

	/**
	 * Harnesses confirmed signed out on this machine (persisted).
	 *
	 * @param harnessId - Harness
	 * @returns True while the owner has not signed it in again
	 */
	isSignedOut(harnessId: HarnessId): boolean {
		return this.state.get(harnessId).signedOutSince !== undefined;
	}

	/**
	 * The signed-out harness an agent is waiting on, if any — for the
	 * owner-message watchdog, which must not wake an agent onto a dead login.
	 *
	 * @param sessionName - Agent session
	 * @returns The harness, or null when its harness is not signed out
	 */
	signedOutHarnessOf(sessionName: string): HarnessId | null {
		const harnessId = this.harnessOfSession(sessionName);
		return harnessId && this.isSignedOut(harnessId) ? harnessId : null;
	}

	/**
	 * Act on a parsed owner login request from the DM.
	 *
	 * @param request - Parsed request
	 * @param target - Conversation to answer in
	 */
	private async handleOwnerLoginRequest(request: OwnerLoginRequest, target: ReloginReplyTarget | null): Promise<void> {
		if (request.kind === 'unknown') {
			await this.notify(formatWhichHarnessDm(request.name), target);
			return;
		}
		const result = this.startOwnerLogin(request.harnessId, { switchAccount: request.switchAccount, replyTarget: target, requestedBy: 'owner_dm' });
		if (result.status === 'no_broker_login') await this.notify(result.message, target);
	}

	/**
	 * Offer a DM to the flows: a login keyword, a login code, or a reply to
	 * an unrecognised screen.
	 *
	 * @param text - Reply text (never logged)
	 * @param target - Conversation it was written in
	 * @returns True when consumed
	 */
	private consumeFlowReply(text: string, target: ReloginReplyTarget | null): boolean {
		if (isLoginKeyword(text)) {
			const flows = [...this.flows.values()];
			for (const flow of flows) {
				this.replaceAndStart(flow.harnessId, flow, {
					trigger: flow.trigger,
					switchAccount: flow.switchAccount,
					replyTarget: target ?? flow.replyTarget,
				});
			}
			this.logger.info('Sign-in started on the owner\'s reply', { harnessIds: flows.map((flow) => flow.harnessId) });
			return true;
		}

		const reply = unwrapReply(text);
		for (const flow of this.flows.values()) {
			if (flow.phase !== 'running' || !flow.sessionId) continue;
			// The code belongs in the conversation the link went to.
			if (flow.linkChannelId && target && target.channelId !== flow.linkChannelId) continue;
			const session = this.readSession(flow.sessionId);
			if (!session || isTerminalLoginState(session.state)) continue;

			const takesCode =
				flow.dm === 'link' && session.method === 'subscription' && session.state === 'awaiting_user' && session.needsInput && looksLikeAuthCode(reply);
			const screenText = flow.dm === 'screen' ? stripScreenReplyPrefix(reply) : null;
			const takesScreenReply =
				screenText !== null &&
				screenText.length > 0 &&
				screenText.length <= HARNESS_CONSTANTS.RELOGIN.SCREEN_REPLY_MAX_LENGTH &&
				!/[\r\n]/.test(screenText);
			if (!takesCode && !takesScreenReply) continue;

			try {
				this.broker.input(flow.sessionId, takesCode ? reply : (screenText as string));
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
	 * Check every harness in use on this machine — the orchestrator's and every
	 * configured agent's, running or not — and report the ones that are signed
	 * out. A harness the status command calls logged in is probed for real now
	 * and then ({@link HARNESS_CONSTANTS.RELOGIN.PROBE_INTERVAL_MS}), because a
	 * stored Claude credential survives its expiry. Signed-out harnesses get
	 * their (backed-off) re-reminder here.
	 *
	 * @returns Resolves when the check is done; never rejects
	 */
	async checkHarnesses(): Promise<void> {
		if (this.statusCheckInFlight) return;
		this.statusCheckInFlight = true;
		try {
			const orc = await this.getOrcHarness().catch(() => null);
			const agents = await this.refreshAgents();
			const configured = new Map<HarnessId, number>();
			for (const agent of agents) {
				if (hasBrokerLogin(agent.harnessId)) configured.set(agent.harnessId, (configured.get(agent.harnessId) ?? 0) + 1);
			}
			const harnesses = new Set<HarnessId>(configured.keys());
			if (orc && hasBrokerLogin(orc)) harnesses.add(orc);

			for (const harnessId of harnesses) {
				const flow = this.flows.get(harnessId);
				if (flow?.phase === 'running' || this.confirming.has(harnessId)) continue;
				if (flow?.phase === 'signed_out' && flow.remind) {
					await this.maybeRemind(flow);
					continue;
				}
				await this.checkOne(harnessId, (configured.get(harnessId) ?? 0) > 0 || harnessId === orc);
			}
		} catch (error) {
			this.logger.warn('Harness status check failed', { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.statusCheckInFlight = false;
		}
	}

	/**
	 * Compatibility name of {@link checkHarnesses}.
	 *
	 * @returns Resolves when the check is done
	 */
	async checkOrcHarness(): Promise<void> {
		await this.checkHarnesses();
	}

	/**
	 * One harness of the periodic check.
	 *
	 * @param harnessId - Harness
	 * @param inUse - The orchestrator or a configured agent runs on it
	 */
	private async checkOne(harnessId: HarnessId, inUse: boolean): Promise<void> {
		const passive = await this.checkLoginState(harnessId).catch((): LoginState => 'unknown');
		if (passive === 'logged_out') {
			const running = this.resumer?.listSessions(harnessId) ?? [];
			// A machine that was never logged in is onboarding's job, not a re-login.
			if (this.state.get(harnessId).seenLoggedInAt === undefined && running.length === 0 && !inUse) return;
			this.reportExpiry({ harnessId, sessionName: null, source: 'status' });
			return;
		}
		if (passive === 'logged_in') this.markSeenLoggedIn(harnessId);
		if (!this.verifyLogin || !inUse) return;
		const last = this.probeCache.get(harnessId);
		if (last && this.now() - last.at < HARNESS_CONSTANTS.RELOGIN.PROBE_INTERVAL_MS) return;
		const probed = await this.probe(harnessId, true);
		if (probed === 'logged_out') this.reportExpiry({ harnessId, sessionName: null, source: 'status' });
	}

	/**
	 * Start the periodic check (first run shortly after boot, so a machine
	 * that comes up signed out says so without waiting a full interval).
	 *
	 * @param intervalMs - Cadence (defaults to STATUS_CHECK_INTERVAL_MS)
	 * @param firstDelayMs - Delay of the first check (default 60 s)
	 */
	start(intervalMs: number = HARNESS_CONSTANTS.RELOGIN.STATUS_CHECK_INTERVAL_MS, firstDelayMs: number = 60_000): void {
		if (this.statusTimer) return;
		this.statusTimer = setInterval(() => void this.checkHarnesses(), intervalMs);
		this.statusTimer.unref?.();
		this.firstCheckTimer = setTimeout(() => void this.checkHarnesses(), firstDelayMs);
		this.firstCheckTimer.unref?.();
	}

	/** Stop the periodic check and forget every flow's timers. */
	stop(): void {
		if (this.statusTimer) clearInterval(this.statusTimer);
		if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer);
		this.statusTimer = null;
		this.firstCheckTimer = null;
		for (const flow of this.flows.values()) this.clearScreenTimer(flow);
	}

	/**
	 * Confirm a suspected expiry, then tell the owner (or use a stored key).
	 *
	 * @param harnessId - Harness
	 */
	private async confirmExpiry(harnessId: HarnessId): Promise<void> {
		try {
			const state = await this.currentState(harnessId);
			const stuck = this.confirming.get(harnessId) ?? new Set<string>();
			if (state !== 'logged_out') {
				// An agent's "401" is not proof the login expired — a bad API key
				// or text typed into the sign-in screen gives one too, and
				// `codex login` revokes a working login when it starts (2026-09-26,
				// Nova). `unknown` (probe failed) is not proof either.
				this.quietUntil.set(harnessId, this.now() + HARNESS_CONSTANTS.RELOGIN.NOT_EXPIRED_QUIET_MS);
				this.logger.warn(
					state === 'logged_in'
						? 'Re-login skipped: the harness is still signed in (the error was not an expired login)'
						: 'Re-login skipped: the harness could not be confirmed as signed out',
					{ harnessId, state, stuck: [...stuck] },
				);
				return;
			}
			this.markSignedOut(harnessId);
			// Names for the notice ("so 2 agents can't work (Crewly Orc, Ella)").
			await this.refreshAgents();
			const current = this.flows.get(harnessId);
			if (current && (current.phase === 'running' || current.remind)) {
				for (const name of stuck) current.stuck.add(name);
				return;
			}
			const flow = this.newFlow(harnessId, stuck, EXPIRY_FLOW, 'signed_out');
			flow.remind = true;
			if (current) {
				flow.replyTarget = current.replyTarget;
				flow.lastOutcome = current.lastOutcome;
			}
			this.flows.set(harnessId, flow);
			if (await this.tryStoredApiKey(flow)) return;
			if (this.flows.get(harnessId) !== flow) return;
			this.logger.warn('Harness is signed out — telling the owner', { harnessId, stuck: [...flow.stuck] });
			await this.sendSignedOutNotice(flow, 'notice');
		} catch (error) {
			this.logger.warn('Confirming a harness expiry failed', { harnessId, error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.confirming.delete(harnessId);
		}
	}

	/**
	 * Login state: the status command, then the live probe when the status
	 * command cannot see an expiry (it says logged in / unknown).
	 *
	 * @param harnessId - Harness
	 * @param fresh - Ignore a cached probe result
	 * @returns The best-known state
	 */
	private async currentState(harnessId: HarnessId, fresh: boolean = false): Promise<LoginState> {
		const passive = await this.checkLoginState(harnessId).catch((): LoginState => 'unknown');
		if (passive === 'logged_out') return 'logged_out';
		const probed = await this.probe(harnessId, fresh);
		return probed === 'unknown' ? passive : probed;
	}

	/**
	 * Run (or reuse) the live probe.
	 *
	 * @param harnessId - Harness
	 * @param fresh - Ignore a cached result
	 * @returns Probe result (`unknown` when there is no probe)
	 */
	private async probe(harnessId: HarnessId, fresh: boolean): Promise<LoginState> {
		if (!this.verifyLogin) return 'unknown';
		const cached = this.probeCache.get(harnessId);
		if (!fresh && cached && this.now() - cached.at < HARNESS_CONSTANTS.RELOGIN.PROBE_CACHE_MS) return cached.state;
		const inFlight = this.probeInFlight.get(harnessId);
		if (inFlight) return inFlight;
		const verify = this.verifyLogin;
		const run = (async (): Promise<LoginState> => {
			try {
				const state = await verify(harnessId).catch((): LoginState => 'unknown');
				this.probeCache.set(harnessId, { at: this.now(), state });
				if (state === 'logged_in') this.markSeenLoggedIn(harnessId);
				this.logger.info('Harness sign-in probe', { harnessId, state });
				return state;
			} finally {
				this.probeInFlight.delete(harnessId);
			}
		})();
		this.probeInFlight.set(harnessId, run);
		return run;
	}

	/**
	 * Re-remind the owner of a signed-out harness once its backoff elapsed. If
	 * the harness is signed in again by then (the owner did it on the
	 * machine or in Setup), the flow finishes and the agents resume instead.
	 *
	 * @param flow - A signed-out flow
	 */
	private async maybeRemind(flow: ReloginFlow): Promise<void> {
		const { harnessId } = flow;
		if (!flow.remind || this.reminding.has(harnessId) || !this.noticeDue(harnessId)) return;
		this.reminding.add(harnessId);
		try {
			const state = await this.currentState(harnessId);
			if (this.flows.get(harnessId) !== flow || flow.phase !== 'signed_out') return;
			if (state === 'logged_in') {
				this.logger.info('Re-login: the harness is signed in again; resuming the waiting agents', { harnessId });
				await this.succeed(flow, true);
				return;
			}
			if (state !== 'logged_out') return;
			this.logger.info('Re-login: reminding the owner', { harnessId, lastOutcome: flow.lastOutcome });
			await this.sendSignedOutNotice(flow, flow.lastOutcome === 'timed_out' ? 'link_expired' : 'reminder');
		} finally {
			this.reminding.delete(harnessId);
		}
	}

	/**
	 * Whether the backoff allows another "signed out" DM for a harness.
	 *
	 * @param harnessId - Harness
	 * @returns True when no notice was sent yet, or the backoff elapsed
	 */
	private noticeDue(harnessId: HarnessId): boolean {
		const record = this.state.get(harnessId);
		if (record.lastNoticeAt === undefined) return true;
		const count = Math.max(1, record.noticeCount ?? 1);
		const { REMIND_BACKOFF_BASE_MS, REMIND_BACKOFF_MAX_MS } = HARNESS_CONSTANTS.RELOGIN;
		const gap = Math.min(REMIND_BACKOFF_BASE_MS * 2 ** (count - 1), REMIND_BACKOFF_MAX_MS);
		return this.now() - record.lastNoticeAt >= gap;
	}

	/**
	 * Send the "signed out" DM (first notice or re-reminder), within the backoff.
	 *
	 * @param flow - The flow
	 * @param kind - Which text
	 */
	private async sendSignedOutNotice(flow: ReloginFlow, kind: 'notice' | 'reminder' | 'link_expired'): Promise<void> {
		const { harnessId } = flow;
		if (!this.noticeDue(harnessId)) {
			this.logger.debug('Re-login: owner already told; next reminder after the backoff', { harnessId });
			return;
		}
		const record = this.state.get(harnessId);
		// A restart forgets the flow but not the notice: the next one is a reminder.
		const text = formatSignedOutDm(harnessId, this.machineName(), this.agentNamesOn(flow), kind === 'notice' && record.lastNoticeAt ? 'reminder' : kind);
		const delivered = await this.dm(flow, text);
		if (!delivered) return;
		this.state.update(harnessId, { lastNoticeAt: this.now(), noticeCount: (record.noticeCount ?? 0) + 1 });
	}

	/**
	 * Replace a harness's flow with a new one and start its broker session.
	 *
	 * @param harnessId - Harness
	 * @param previous - The flow it replaces (its stuck agents are kept), or null
	 * @param options - Trigger, wording and reply target
	 */
	private replaceAndStart(harnessId: HarnessId, previous: ReloginFlow | null, options: FlowOptions): void {
		if (previous) {
			this.clearScreenTimer(previous);
			this.cancelOwnSession(previous);
			if (this.flows.get(harnessId) === previous) this.flows.delete(harnessId);
		}
		// The owner asked: a quiet period after the last login must not swallow it.
		this.quietUntil.delete(harnessId);
		const flow = this.newFlow(harnessId, new Set(previous?.stuck ?? []), options, 'running');
		flow.remind = previous?.remind ?? false;
		this.flows.set(harnessId, flow);
		this.startBrokerSession(flow);
	}

	/**
	 * A new flow record.
	 *
	 * @param harnessId - Harness
	 * @param stuck - Sessions known to be stuck
	 * @param options - Trigger, wording and reply target
	 * @param phase - Initial phase
	 * @returns The flow (not registered)
	 */
	private newFlow(harnessId: HarnessId, stuck: Set<string>, options: FlowOptions, phase: ReloginFlow['phase']): ReloginFlow {
		return {
			harnessId,
			phase,
			sessionId: null,
			startedAt: this.now(),
			stuck,
			dm: 'none',
			lastDmAt: null,
			replied: false,
			lastRejection: null,
			screenTimer: null,
			cancelledByUs: false,
			trigger: options.trigger,
			switchAccount: options.switchAccount,
			replyTarget: options.replyTarget,
			linkChannelId: null,
			lastOutcome: null,
			remind: false,
			restartAll: true,
		};
	}

	/**
	 * Start (or adopt) the harness's broker login session for a flow.
	 *
	 * @param flow - The flow
	 */
	private startBrokerSession(flow: ReloginFlow): void {
		const method = getBrokerLoginMethod(flow.harnessId);
		if (!method) return;
		let session: LoginSession;
		try {
			session = this.broker.start(flow.harnessId, method.id);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.warn('Re-login: could not start the login', { harnessId: flow.harnessId, error: reason });
			flow.phase = 'signed_out';
			void this.dm(flow, formatFailureDm(flow.harnessId, `Crewly could not start the sign-in (${reason})`));
			return;
		}
		flow.sessionId = session.id;
		flow.startedAt = Date.parse(session.startedAt) || this.now();
		flow.screenTimer = setTimeout(() => void this.sendScreenIfUnrecognised(flow), HARNESS_CONSTANTS.RELOGIN.UNRECOGNISED_SCREEN_MS);
		flow.screenTimer.unref?.();
		this.logger.info('Re-login broker session started', { harnessId: flow.harnessId, sessionId: session.id, method: method.id, trigger: flow.trigger });
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
			void this.dm(flow, formatLinkDm(session, [], this.wordingOf(flow))).then((delivered) => {
				if (typeof delivered === 'object' && delivered) flow.linkChannelId = delivered.channelId;
				else if (delivered && flow.replyTarget) flow.linkChannelId = flow.replyTarget.channelId;
			});
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
		if (!flow) {
			// Signed in from the dashboard / Setup with no flow here: the agents
			// parked on a sign-in screen still hold the dead login.
			if (session.state === 'succeeded') void this.adoptOutsideLogin(session.harnessId);
			return;
		}
		if (flow.sessionId !== session.id) {
			// The owner logged in another way (web / phone app) while a flow waited.
			if (session.state === 'succeeded') {
				this.clearScreenTimer(flow);
				this.cancelOwnSession(flow);
				void this.succeed(flow, true);
			}
			return;
		}
		if (flow.phase !== 'running' || flow.cancelledByUs) return;
		this.clearScreenTimer(flow);
		flow.lastOutcome = session.state;

		if (session.state === 'succeeded') {
			void this.confirmAndSucceed(flow);
			return;
		}
		flow.phase = 'signed_out';
		flow.sessionId = null;
		flow.dm = 'none';
		flow.remind = flow.remind || this.isSignedOut(flow.harnessId);
		if (session.state === 'cancelled') {
			// Cancelled on the web or by a shutdown: the owner knows; stay quiet.
			this.logger.info('Re-login cancelled', { harnessId: flow.harnessId, sessionId: session.id });
			return;
		}
		this.logger.warn('Re-login did not finish', { harnessId: flow.harnessId, sessionId: session.id, state: session.state });
		const text =
			session.state === 'timed_out'
				? formatSignedOutDm(flow.harnessId, this.machineName(), this.agentNamesOn(flow), 'link_expired')
				: formatFailureDm(flow.harnessId, session.message);
		void this.dm(flow, text);
	}

	/**
	 * A login finished outside any flow (dashboard chip, Setup, CLI): restart
	 * only the sessions that sit at a sign-in screen and re-deliver what
	 * waited for them. Working agents of the harness are left alone.
	 *
	 * @param harnessId - Harness that was signed in
	 */
	private async adoptOutsideLogin(harnessId: HarnessId): Promise<void> {
		if (!hasBrokerLogin(harnessId)) return;
		let live: string[] = [];
		try {
			live = this.resumer?.listSessions(harnessId) ?? [];
		} catch {
			live = [];
		}
		const waiting = live.filter((name) => this.sessionNeedsLogin?.(name) === true);
		const wasSignedOut = this.isSignedOut(harnessId);
		if (waiting.length === 0 && !wasSignedOut) {
			this.markSeenLoggedIn(harnessId);
			return;
		}
		const flow = this.newFlow(harnessId, new Set(waiting), { trigger: 'expiry', switchAccount: false, replyTarget: null }, 'running');
		flow.restartAll = false;
		this.logger.info('Signed in outside Slack; resuming the agents that waited', { harnessId, waiting });
		await this.succeed(flow, wasSignedOut);
	}

	/**
	 * The broker reported success: confirm it with the probe, then finish.
	 *
	 * @param flow - The flow
	 */
	private async confirmAndSucceed(flow: ReloginFlow): Promise<void> {
		const state = await this.probe(flow.harnessId, true);
		if (this.flows.get(flow.harnessId) !== flow) return;
		if (state === 'logged_out') {
			this.logger.warn('Re-login: the sign-in finished but the harness still cannot reach its API', { harnessId: flow.harnessId });
			flow.phase = 'signed_out';
			flow.sessionId = null;
			flow.dm = 'none';
			flow.remind = true;
			this.markSignedOut(flow.harnessId);
			await this.dm(flow, formatFailureDm(flow.harnessId, 'the sign-in finished, but it still does not work'));
			return;
		}
		await this.succeed(flow, true);
	}

	/**
	 * The login is back: restart the stuck agents, re-deliver what waited,
	 * and tell the owner.
	 *
	 * @param flow - The flow
	 * @param notify - DM the owner (false for the silent API-key path)
	 */
	private async succeed(flow: ReloginFlow, notify: boolean): Promise<void> {
		const { harnessId } = flow;
		if (this.flows.get(harnessId) === flow) this.flows.delete(harnessId);
		this.quietUntil.set(harnessId, this.now() + HARNESS_CONSTANTS.RELOGIN.POST_SUCCESS_QUIET_MS);
		this.probeCache.set(harnessId, { at: this.now(), state: 'logged_in' });
		this.state.update(harnessId, { signedOutSince: undefined, lastNoticeAt: undefined, noticeCount: undefined, seenLoggedInAt: this.now() });

		const sessions = this.sessionsToRestart(flow);
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

		let redelivered = 0;
		if (this.onLoginRestored) {
			try {
				redelivered = (await this.onLoginRestored(harnessId, result.resumed)) || 0;
			} catch (error) {
				this.logger.warn('Re-login: re-delivering waiting messages failed', { error: error instanceof Error ? error.message : String(error) });
			}
		}
		this.logger.info('Re-login finished', { harnessId, resumed: result.resumed.length, failed: result.failed.length, redelivered });
		if (notify) {
			const text =
				flow.trigger === 'owner'
					? formatOwnerSuccessDm(harnessId, result, redelivered)
					: formatSuccessDm(harnessId, result, redelivered, this.machineName());
			await this.dm(flow, text);
		}
	}

	/**
	 * Sessions to restart after a login: the ones whose output matched plus
	 * every live session of the harness (they all hold the dead login).
	 *
	 * @param flow - The flow
	 * @returns Session names
	 */
	private sessionsToRestart(flow: ReloginFlow): string[] {
		let live: string[] = [];
		try {
			live = this.resumer?.listSessions(flow.harnessId) ?? [];
		} catch {
			live = [];
		}
		if (!flow.restartAll) return [...flow.stuck];
		return [...new Set([...flow.stuck, ...live])];
	}

	/**
	 * Names of the agents that run on a flow's harness, for the owner: every
	 * configured agent on it, else the stuck / live ones.
	 *
	 * @param flow - The flow
	 * @returns Display names
	 */
	private agentNamesOn(flow: ReloginFlow): string[] {
		const configured = this.agents.filter((agent) => agent.harnessId === flow.harnessId);
		if (configured.length > 0) return configured.map((agent) => agent.displayName || agent.sessionName);
		const byName = new Map(this.agents.map((agent) => [agent.sessionName, agent.displayName || agent.sessionName]));
		return this.sessionsToRestart(flow).map((name) => byName.get(name) ?? name);
	}

	/**
	 * Re-read the configured agents.
	 *
	 * @returns The agents (the last known list when the read fails)
	 */
	private async refreshAgents(): Promise<ConfiguredAgent[]> {
		if (!this.listAgents) return this.agents;
		try {
			this.agents = await this.listAgents();
		} catch (error) {
			this.logger.debug('Listing configured agents failed', { error: error instanceof Error ? error.message : String(error) });
		}
		return this.agents;
	}

	/**
	 * Harness an agent session runs on.
	 *
	 * @param sessionName - Agent session
	 * @returns Harness id, or null when unknown
	 */
	private harnessOfSession(sessionName: string): HarnessId | null {
		const configured = this.agents.find((agent) => agent.sessionName === sessionName);
		if (configured && isHarnessId(configured.harnessId)) return configured.harnessId;
		for (const flow of this.flows.values()) if (flow.stuck.has(sessionName)) return flow.harnessId;
		return null;
	}

	/**
	 * Record that a harness is signed out (first time only keeps the date).
	 *
	 * @param harnessId - Harness
	 */
	private markSignedOut(harnessId: HarnessId): void {
		if (this.state.get(harnessId).signedOutSince === undefined) this.state.update(harnessId, { signedOutSince: this.now() });
	}

	/**
	 * Remember that a harness was seen signed in (written at most hourly).
	 *
	 * @param harnessId - Harness
	 */
	private markSeenLoggedIn(harnessId: HarnessId): void {
		const record = this.state.get(harnessId);
		if (record.signedOutSince !== undefined) return;
		if (record.seenLoggedInAt !== undefined && this.now() - record.seenLoggedInAt < HARNESS_CONSTANTS.RELOGIN.PROBE_INTERVAL_MS) return;
		this.state.update(harnessId, { seenLoggedInAt: this.now() });
	}

	/**
	 * DM wording for a flow.
	 *
	 * @param flow - The flow
	 * @returns Account-switch flag and machine name
	 */
	private wordingOf(flow: ReloginFlow): LoginDmWording {
		return { ownerRequested: flow.trigger === 'owner', switchAccount: flow.switchAccount, machine: this.machineName() };
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
		const delivered = await this.dm(flow, formatScreenDm(session, [], this.wordingOf(flow)));
		if (typeof delivered === 'object' && delivered) flow.linkChannelId = delivered.channelId;
	}

	/**
	 * DM the owner in the flow's conversation, and remember where it landed
	 * so later DMs (the link, the result) follow it.
	 *
	 * @param flow - The flow
	 * @param text - DM text
	 * @returns The delivery
	 */
	private async dm(flow: ReloginFlow, text: string): Promise<ReloginDelivery> {
		flow.lastDmAt = this.now();
		const delivered = await this.notify(text, flow.replyTarget, flow.harnessId);
		if (typeof delivered === 'object' && delivered && !flow.replyTarget) flow.replyTarget = delivered;
		return delivered;
	}

	/**
	 * Send a message to the owner (logs when no notifier is wired; never logs the text).
	 *
	 * @param text - DM text
	 * @param target - Conversation to answer in (null = this machine's DM)
	 * @param harnessId - Harness, for logs
	 * @returns The delivery (false when not delivered)
	 */
	private async notify(text: string, target: ReloginReplyTarget | null, harnessId?: HarnessId): Promise<ReloginDelivery> {
		if (!this.notifier) {
			this.logger.warn('Re-login: no Slack DM path to the owner; finish the login from Setup', { harnessId });
			return false;
		}
		try {
			const delivered = await this.notifier.sendToOwner(text, target);
			if (!delivered) this.logger.warn('Re-login: the owner DM was not delivered', { harnessId });
			return delivered;
		} catch (error) {
			this.logger.warn('Re-login: sending the owner DM failed', {
				harnessId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
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
 * (its broker, credentials, API keys and status), the live sign-in probe and
 * the persisted notice state. Registers itself as the `reloginPending`
 * source of `GET /api/harness`.
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
			verifyLogin: createHarnessLoginProbe(),
			getOrcHarness: () => harness.orc.get(),
			state: createDefaultReloginStateStore(),
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

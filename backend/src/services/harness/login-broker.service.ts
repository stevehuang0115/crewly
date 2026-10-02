/**
 * Login broker — runs a harness's own login command in a PTY and relays it.
 *
 * The broker knows nothing about harness APIs. It spawns the login command
 * (`claude setup-token`, `codex login --device-auth`) in a very wide PTY,
 * normalizes the screen and applies the harness's rule set (login-rules.ts)
 * to find the sign-in URL, a one-time code, a "paste the code" prompt,
 * success and failure. Front ends read the resulting {@link LoginSession}
 * and send the user's reply back with {@link LoginBrokerService.input}.
 *
 * Front ends are consumers of the same events: the REST API polls
 * {@link LoginBrokerService.get}, the CLI awaits
 * {@link LoginBrokerService.waitForCompletion}, and Phase 2 (re-login over
 * Slack DM) subscribes to the `update` / `finished` events.
 *
 * Secrets: Claude's long-lived token is captured from the screen, stored with
 * {@link HarnessCredentialsStore.setClaudeOauthToken}, redacted from every
 * exposed screen and scrubbed from the raw buffer. It is never logged or
 * emitted.
 *
 * State machine:
 * `starting` → `awaiting_user` (URL / code / prompt seen) → `verifying`
 * (input sent, or the command reported success and is being confirmed) →
 * `succeeded` | `failed`; any live state → `timed_out` (15 min) | `cancelled`.
 * A prompt that reappears after input returns the session to `awaiting_user`.
 *
 * Harnesses that save their own credentials and exit (Codex) are never killed
 * on a failure line: the broker waits for the exit (bounded by
 * FAILURE_EXIT_GRACE_MS), and a non-zero exit is checked with the harness's
 * status command before it is reported as failed. On 2026-09-29/30 the owner
 * finished the device login four times on steamfun-ops (Codex logged
 * "oauth token exchange succeeded"), every attempt was reported `failed`, and
 * each retry's `codex login` revoked the previous one. The failure message is
 * now logged (redacted) so the next such report says why.
 *
 * @module services/harness/login-broker.service
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as pty from 'node-pty';
import { API_SECURITY_CONSTANTS, HARNESS_CONSTANTS } from '../../constants.js';
import { stripNestedClaudeSessionEnv } from '../agent/runtime-session-recovery.js';
import { ensureClaudeAccountDir, prepareClaudeAccountAfterLogin } from './claude-accounts.js';
import { prepareClaudeConfigForCrewlyLogin } from './claude-config.utils.js';
import { HarnessCredentialsStore, getHarnessCredentialsStore } from './harness-credentials.store.js';
import { buildHarnessPath, resolveExecutable } from './harness-exec.utils.js';
import { getHarnessDefinition, getLoginMethod } from './harness-registry.js';
import {
	SILENT_HARNESS_LOGGER,
	isTerminalLoginState,
	type HarnessId,
	type HarnessLogger,
	type LoginMethodId,
	type LoginSession,
	type LoginSessionState,
} from './harness.types.js';
import { evaluateLoginRules, getLoginRules, normalizeTerminalOutput, redactSecrets, type LoginRuleSet } from './login-rules.js';

/** The slice of a PTY the broker uses (node-pty's IPty satisfies it). */
export interface BrokerPty {
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
	write(data: string): void;
	kill(signal?: string): void;
}

/** Spawns a PTY. */
export type BrokerPtySpawner = (
	file: string,
	args: string[],
	options: { cols: number; rows: number; cwd: string; env: Record<string, string> },
) => BrokerPty;

/** Events emitted by the broker. Listeners receive a {@link LoginSession} (never a secret). */
export const LOGIN_BROKER_EVENTS = {
	/** Any change to a session */
	UPDATE: 'update',
	/** A session reached a terminal state */
	FINISHED: 'finished',
} as const;

/** Error codes the REST layer maps to HTTP statuses. */
export type LoginBrokerErrorCode = 'unknown_harness' | 'unsupported_method' | 'not_installed' | 'spawn_failed' | 'not_found' | 'not_active';

/** Broker error with a machine-readable code. */
export class LoginBrokerError extends Error {
	/**
	 * @param code - Machine-readable code
	 * @param message - Human-readable message (never contains a secret)
	 */
	constructor(
		public readonly code: LoginBrokerErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'LoginBrokerError';
	}
}

/** Injectable dependencies. */
export interface LoginBrokerDeps {
	spawnPty?: BrokerPtySpawner;
	/** PATH lookup for the login command */
	resolveCommand?: (command: string, envPath: string) => string | null;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	credentials?: HarnessCredentialsStore;
	/** Confirms a login with the harness's own status command (Codex) */
	verify?: (harnessId: HarnessId) => Promise<boolean>;
	/** Records Claude's first-run answers after a Claude login */
	prepareClaudeConfig?: () => void;
	/** Creates one of the owner's other Claude Code accounts' config dir; returns it */
	ensureAccountDir?: (account: string) => string;
	/** Records Claude's first-run answers in an account's config dir after its login */
	prepareAccount?: (account: string) => void;
	now?: () => number;
	idFactory?: () => string;
	logger?: HarnessLogger;
	timeoutMs?: number;
	/** Pause before Enter after typed input (ms); 0 types both in one write (tests) */
	submitDelayMs?: number;
	/** Second Enter when the login printed nothing after the first (ms); 0 disables */
	submitRetryMs?: number;
}

/** Internal session record. */
interface SessionRecord {
	session: LoginSession;
	rules: LoginRuleSet;
	pty: BrokerPty | null;
	raw: string;
	/** Offset in `raw` of the output that followed the user's last input */
	inputOffset: number;
	secrets: string[];
	timer: NodeJS.Timeout | null;
	/** A failure line was seen; waiting for the process to exit (Codex) */
	pendingFailure: string | null;
	failureTimer: NodeJS.Timeout | null;
	exited: boolean;
	finishedAt: number | null;
	done: Promise<LoginSession>;
	resolveDone: (session: LoginSession) => void;
}

/**
 * Default PTY spawner (node-pty).
 *
 * @param file - Executable
 * @param args - Arguments
 * @param options - Size, cwd, env
 * @returns The PTY
 */
const defaultSpawnPty: BrokerPtySpawner = (file, args, options) =>
	pty.spawn(file, args, { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });

/** Runs harness login commands in PTYs and tracks their sessions. */
export class LoginBrokerService extends EventEmitter {
	private readonly spawnPty: BrokerPtySpawner;
	private readonly resolveCommand: (command: string, envPath: string) => string | null;
	private readonly env: NodeJS.ProcessEnv;
	private readonly homeDir: string;
	private readonly credentials: HarnessCredentialsStore;
	private readonly verify: (harnessId: HarnessId) => Promise<boolean>;
	private readonly prepareClaudeConfig: () => void;
	private readonly ensureAccountDir: (account: string) => string;
	private readonly prepareAccount: (account: string) => void;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private readonly logger: HarnessLogger;
	private readonly timeoutMs: number;
	private readonly sessions = new Map<string, SessionRecord>();
	/** Sessions whose verification is in flight. */
	private readonly verifying = new Set<string>();
	private readonly submitDelayMs: number;
	private readonly submitRetryMs: number;

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: LoginBrokerDeps = {}) {
		super();
		this.spawnPty = deps.spawnPty ?? defaultSpawnPty;
		this.resolveCommand = deps.resolveCommand ?? ((command, envPath) => resolveExecutable(command, envPath));
		this.env = deps.env ?? process.env;
		this.homeDir = deps.homeDir ?? os.homedir();
		this.credentials = deps.credentials ?? getHarnessCredentialsStore();
		this.verify = deps.verify ?? (async () => true);
		this.prepareClaudeConfig = deps.prepareClaudeConfig ?? (() => void prepareClaudeConfigForCrewlyLogin());
		this.ensureAccountDir = deps.ensureAccountDir ?? ((account) => ensureClaudeAccountDir(account));
		this.prepareAccount = deps.prepareAccount ?? ((account) => prepareClaudeAccountAfterLogin(account));
		this.now = deps.now ?? Date.now;
		this.idFactory = deps.idFactory ?? randomUUID;
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
		this.timeoutMs = deps.timeoutMs ?? HARNESS_CONSTANTS.LOGIN.TIMEOUT_MS;
		this.submitDelayMs = deps.submitDelayMs ?? HARNESS_CONSTANTS.LOGIN.SUBMIT_DELAY_MS;
		this.submitRetryMs = deps.submitRetryMs ?? HARNESS_CONSTANTS.LOGIN.SUBMIT_RETRY_MS;
	}

	/**
	 * Environment for the login PTY: the harness PATH, no owner API token, no
	 * nested-Claude-session markers, and a no-op BROWSER so the harness does
	 * not try to open a browser on the server.
	 *
	 * @returns String-only env map
	 */
	buildEnv(): Record<string, string> {
		const cleaned = stripNestedClaudeSessionEnv({ ...this.env });
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(cleaned)) {
			if (value !== undefined && key !== API_SECURITY_CONSTANTS.ENV.API_TOKEN) env[key] = value;
		}
		env.PATH = buildHarnessPath(this.env.PATH, this.homeDir);
		env.BROWSER = HARNESS_CONSTANTS.LOGIN.BROWSER_SUPPRESS_VALUE;
		env.TERM = 'xterm-256color';
		return env;
	}

	/**
	 * Start a login session, or return the live one for this harness (and account).
	 *
	 * With `options.account` (Claude Code only, issue #942) the login is for
	 * one of the owner's other Claude Code accounts: it runs with that
	 * account's config dir (`CLAUDE_CONFIG_DIR`) and none of the default
	 * login's credentials, and the token is stored for that account only.
	 *
	 * @param harnessId - Harness id
	 * @param method - Broker login method (`subscription`, `device`)
	 * @param options - `account`: one of the owner's other Claude Code accounts (validated name)
	 * @returns The session
	 * @throws LoginBrokerError unknown_harness | unsupported_method | not_installed | spawn_failed
	 */
	start(harnessId: string, method: string, options: { account?: string } = {}): LoginSession {
		const def = getHarnessDefinition(harnessId);
		if (!def) throw new LoginBrokerError('unknown_harness', `Unknown harness: ${harnessId}`);
		const methodDef = getLoginMethod(def.id, method);
		const rules = getLoginRules(def.id, method);
		if (!methodDef || methodDef.kind !== 'broker' || !methodDef.broker || !rules) {
			throw new LoginBrokerError('unsupported_method', `${def.displayName} has no "${method}" login that Crewly can run`);
		}
		const account = options.account;
		if (account && (def.id !== HARNESS_CONSTANTS.IDS.CLAUDE_CODE || !rules.successRequiresSecret)) {
			throw new LoginBrokerError('unsupported_method', `${def.displayName} has no per-account "${method}" login`);
		}

		const live = this.getActiveSession(def.id, account);
		if (live) return live;
		this.prune();

		const env = this.buildEnv();
		if (account) {
			try {
				env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV] = this.ensureAccountDir(account);
			} catch (error) {
				throw new LoginBrokerError('spawn_failed', `Could not create the account folder: ${error instanceof Error ? error.message : String(error)}`);
			}
			delete env[HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV];
			delete env[HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV];
		}
		const binary = this.resolveCommand(methodDef.broker.command, env.PATH);
		if (!binary) {
			throw new LoginBrokerError('not_installed', `${def.displayName} is not installed (\`${methodDef.broker.command}\` not found)`);
		}

		const nowIso = new Date(this.now()).toISOString();
		let resolveDone: (session: LoginSession) => void = () => undefined;
		const done = new Promise<LoginSession>((resolve) => {
			resolveDone = resolve;
		});
		const record: SessionRecord = {
			session: {
				id: this.idFactory(),
				harnessId: def.id,
				...(account ? { account } : {}),
				method: method as LoginMethodId,
				state: 'starting',
				url: null,
				userCode: null,
				needsInput: false,
				message: null,
				screen: '',
				startedAt: nowIso,
				updatedAt: nowIso,
			},
			rules,
			pty: null,
			raw: '',
			inputOffset: 0,
			secrets: [],
			timer: null,
			pendingFailure: null,
			failureTimer: null,
			exited: false,
			finishedAt: null,
			done,
			resolveDone,
		};

		try {
			record.pty = this.spawnPty(binary, [...methodDef.broker.args], {
				cols: HARNESS_CONSTANTS.LOGIN.PTY_COLS,
				rows: HARNESS_CONSTANTS.LOGIN.PTY_ROWS,
				cwd: this.homeDir,
				env,
			});
		} catch (error) {
			throw new LoginBrokerError('spawn_failed', `Could not start \`${methodDef.broker.command}\`: ${error instanceof Error ? error.message : String(error)}`);
		}

		this.sessions.set(record.session.id, record);
		record.pty.onData((data) => this.handleData(record, data));
		record.pty.onExit(({ exitCode }) => {
			void this.handleExit(record, exitCode);
		});
		record.timer = setTimeout(() => this.finish(record, 'timed_out', 'The login was not completed in time.'), this.timeoutMs);
		record.timer.unref?.();
		this.logger.info('Login broker session started', { sessionId: record.session.id, harnessId: def.id, method });
		return { ...record.session };
	}

	/**
	 * Read a session.
	 *
	 * @param sessionId - Session id
	 * @returns The session
	 * @throws LoginBrokerError not_found
	 */
	get(sessionId: string): LoginSession {
		return { ...this.requireRecord(sessionId).session };
	}

	/**
	 * The live (non-terminal) session for a harness (and account), if any.
	 *
	 * @param harnessId - Harness id
	 * @param account - One of the owner's other Claude Code accounts; absent = the default login
	 * @returns The session, or null
	 */
	getActiveSession(harnessId: string, account?: string): LoginSession | null {
		for (const record of this.sessions.values()) {
			if (record.session.harnessId !== harnessId || (record.session.account ?? undefined) !== account) continue;
			if (!isTerminalLoginState(record.session.state)) return { ...record.session };
		}
		return null;
	}

	/**
	 * Type the user's reply into the PTY, followed by Enter.
	 *
	 * @param sessionId - Session id
	 * @param text - What the user typed (e.g. the code from platform.claude.com)
	 * @returns The session
	 * @throws LoginBrokerError not_found | not_active
	 */
	input(sessionId: string, text: string): LoginSession {
		const record = this.requireRecord(sessionId);
		if (isTerminalLoginState(record.session.state) || !record.pty || record.exited) {
			throw new LoginBrokerError('not_active', 'This login has already finished');
		}
		record.inputOffset = record.raw.length;
		const typed = text.replace(/[\r\n]+/g, '');
		const { ENTER } = HARNESS_CONSTANTS.LOGIN;
		if (this.submitDelayMs <= 0) {
			record.pty.write(`${typed}${ENTER}`);
		} else {
			// Type, pause, then Enter on its own: an Ink TUI treats one write of
			// "code + Enter" as a paste and keeps the Enter inside it.
			record.pty.write(typed);
			const pty = record.pty;
			setTimeout(() => {
				if (record.exited || isTerminalLoginState(record.session.state)) return;
				pty.write(ENTER);
				const rawAtEnter = record.raw.length;
				if (this.submitRetryMs > 0) {
					setTimeout(() => {
						// Nothing printed since Enter: it was not taken — press it once more.
						if (record.exited || isTerminalLoginState(record.session.state)) return;
						if (record.raw.length === rawAtEnter) {
							this.logger.warn('Login input not submitted — pressing Enter again', { sessionId: record.session.id });
							pty.write(ENTER);
						}
					}, this.submitRetryMs).unref?.();
				}
			}, this.submitDelayMs).unref?.();
		}
		this.update(record, { state: 'verifying', needsInput: false, message: null });
		return { ...record.session };
	}

	/**
	 * Cancel a session (kills the PTY). Cancelling a finished session is a no-op.
	 *
	 * @param sessionId - Session id
	 * @returns The session
	 * @throws LoginBrokerError not_found
	 */
	cancel(sessionId: string): LoginSession {
		const record = this.requireRecord(sessionId);
		if (!isTerminalLoginState(record.session.state)) this.finish(record, 'cancelled', 'Login cancelled.');
		return { ...record.session };
	}

	/**
	 * Resolve when the session reaches a terminal state.
	 *
	 * @param sessionId - Session id
	 * @returns The final session
	 * @throws LoginBrokerError not_found
	 */
	async waitForCompletion(sessionId: string): Promise<LoginSession> {
		const record = this.requireRecord(sessionId);
		if (isTerminalLoginState(record.session.state)) return { ...record.session };
		return record.done;
	}

	/** Cancel every live session (backend shutdown, CLI exit). */
	shutdown(): void {
		for (const record of this.sessions.values()) {
			if (!isTerminalLoginState(record.session.state)) this.finish(record, 'cancelled', 'Login cancelled: Crewly is shutting down.');
		}
	}

	/**
	 * Session record or a not_found error.
	 *
	 * @param sessionId - Session id
	 * @returns The record
	 * @throws LoginBrokerError not_found
	 */
	private requireRecord(sessionId: string): SessionRecord {
		const record = this.sessions.get(sessionId);
		if (!record) throw new LoginBrokerError('not_found', `Login session not found: ${sessionId}`);
		return record;
	}

	/**
	 * Append PTY output and re-evaluate the rules.
	 *
	 * @param record - Session record
	 * @param data - Output chunk
	 */
	private handleData(record: SessionRecord, data: string): void {
		if (isTerminalLoginState(record.session.state)) return;
		record.raw += data;
		const max = HARNESS_CONSTANTS.LOGIN.RAW_BUFFER_MAX_CHARS;
		if (record.raw.length > max) {
			const drop = record.raw.length - max;
			record.raw = record.raw.slice(drop);
			record.inputOffset = Math.max(0, record.inputOffset - drop);
		}
		this.evaluate(record, false);
	}

	/**
	 * Apply the rule set to the current screen and move the state machine.
	 *
	 * @param record - Session record
	 * @param final - The process has exited
	 */
	private evaluate(record: SessionRecord, final: boolean): void {
		const screen = normalizeTerminalOutput(record.raw);
		const promptScreen = normalizeTerminalOutput(record.raw.slice(record.inputOffset));
		const match = evaluateLoginRules(record.rules, screen, { promptScreen, final });
		if (match.secret && !record.secrets.includes(match.secret)) record.secrets.push(match.secret);

		const patch: Partial<LoginSession> = {
			url: match.url ?? record.session.url,
			userCode: match.userCode ?? record.session.userCode,
			needsInput: match.needsInput,
			screen: this.exposedScreen(record, screen.text),
		};

		if (match.succeeded) {
			this.update(record, patch);
			void this.complete(record, match.secret);
			return;
		}
		if (match.failureMessage) {
			if (match.needsInput) {
				// The harness rejected the reply and asks again.
				this.update(record, { ...patch, state: 'awaiting_user', message: match.failureMessage });
			} else if (record.rules.successOnExitZero) {
				// The harness exits by itself and may still be saving a login:
				// never kill it mid-write. Its exit decides (see handleExit).
				this.update(record, { ...patch, message: match.failureMessage });
				if (final || record.exited) record.pendingFailure = match.failureMessage;
				else this.awaitExitAfterFailure(record, match.failureMessage);
			} else {
				this.update(record, patch);
				this.finish(record, 'failed', match.failureMessage);
			}
			return;
		}
		let state: LoginSessionState = record.session.state;
		if (state === 'starting' && (patch.url || patch.userCode || match.needsInput)) state = 'awaiting_user';
		if (state === 'verifying' && match.needsInput) state = 'awaiting_user';
		this.update(record, { ...patch, state });
	}

	/**
	 * A failure line was printed by a harness that exits by itself: give it
	 * FAILURE_EXIT_GRACE_MS to exit before failing the session.
	 *
	 * @param record - Session record
	 * @param message - The failure line
	 */
	private awaitExitAfterFailure(record: SessionRecord, message: string): void {
		record.pendingFailure = message;
		if (record.failureTimer) return;
		record.failureTimer = setTimeout(() => {
			record.failureTimer = null;
			if (!record.exited) this.finish(record, 'failed', record.pendingFailure ?? message);
		}, HARNESS_CONSTANTS.LOGIN.FAILURE_EXIT_GRACE_MS);
		record.failureTimer.unref?.();
	}

	/**
	 * Handle a reported success: store the secret (Claude) or confirm (Codex).
	 *
	 * @param record - Session record
	 * @param secret - Captured credential, when the rule set has one
	 */
	private async complete(record: SessionRecord, secret: string | null): Promise<void> {
		if (isTerminalLoginState(record.session.state)) return;
		if (record.rules.successRequiresSecret) {
			if (!secret) return;
			try {
				this.storeSecret(record, secret);
			} catch (error) {
				this.finish(record, 'failed', `Login worked, but Crewly could not save the token: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			this.finish(record, 'succeeded', 'Logged in. Crewly saved the token for its agents.');
			return;
		}
		await this.confirm(record);
	}

	/**
	 * Confirm a login with the harness's status command.
	 *
	 * @param record - Session record
	 */
	private async confirm(record: SessionRecord): Promise<void> {
		if (this.verifying.has(record.session.id) || isTerminalLoginState(record.session.state)) return;
		this.verifying.add(record.session.id);
		this.update(record, { state: 'verifying', needsInput: false });
		try {
			const ok = record.rules.verifyAfterSuccess ? await this.verify(record.session.harnessId) : true;
			if (isTerminalLoginState(record.session.state)) return;
			if (ok) this.finish(record, 'succeeded', 'Logged in.');
			else this.finish(record, 'failed', 'The login command finished, but the harness still reports it is not logged in.');
		} catch (error) {
			if (!isTerminalLoginState(record.session.state)) {
				this.finish(record, 'failed', `Could not confirm the login: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.verifying.delete(record.session.id);
		}
	}

	/**
	 * Save a captured credential. Never logs it.
	 *
	 * @param record - Session record
	 * @param secret - The credential
	 */
	private storeSecret(record: SessionRecord, secret: string): void {
		const account = record.session.account;
		if (record.session.harnessId === HARNESS_CONSTANTS.IDS.CLAUDE_CODE && account) {
			this.credentials.setClaudeAccountToken(account, secret);
			try {
				this.prepareAccount(account);
			} catch (error) {
				this.logger.warn('Could not update the account\'s Claude config after login', { error: error instanceof Error ? error.message : String(error) });
			}
		} else if (record.session.harnessId === HARNESS_CONSTANTS.IDS.CLAUDE_CODE) {
			this.credentials.setClaudeOauthToken(secret);
			try {
				this.prepareClaudeConfig();
			} catch (error) {
				this.logger.warn('Could not update Claude config after login', { error: error instanceof Error ? error.message : String(error) });
			}
		}
		// Scrub the secret from the raw buffer now that it is stored.
		record.raw = record.raw.split(secret).join(HARNESS_CONSTANTS.LOGIN.REDACTED);
		this.logger.info('Harness credential stored', { sessionId: record.session.id, harnessId: record.session.harnessId });
	}

	/**
	 * The login command exited.
	 *
	 * @param record - Session record
	 * @param exitCode - Process exit code
	 */
	private async handleExit(record: SessionRecord, exitCode: number): Promise<void> {
		record.exited = true;
		if (isTerminalLoginState(record.session.state)) return;
		this.evaluate(record, true);
		if (isTerminalLoginState(record.session.state) || this.verifying.has(record.session.id)) return;
		if (record.rules.successOnExitZero && exitCode === 0) {
			await this.confirm(record);
			return;
		}
		const failure = record.pendingFailure ?? record.session.message ?? `The login command exited (code ${exitCode}) before the login finished.`;
		if (record.rules.verifyAfterSuccess) {
			// The login command clears the old credentials when it starts, so a
			// logged-in status now means this login landed despite the exit code.
			let loggedIn = false;
			try {
				loggedIn = await this.verify(record.session.harnessId);
			} catch {
				loggedIn = false;
			}
			if (isTerminalLoginState(record.session.state)) return;
			if (loggedIn) {
				this.logger.warn('Login command reported a failure, but the harness is logged in — treating it as success', {
					sessionId: record.session.id,
					harnessId: record.session.harnessId,
					exitCode,
					reported: this.safeMessage(record, failure),
				});
				this.finish(record, 'succeeded', 'Logged in.');
				return;
			}
		}
		this.finish(record, 'failed', failure);
	}

	/**
	 * Move a session to a terminal state and release the PTY.
	 *
	 * @param record - Session record
	 * @param state - Terminal state
	 * @param message - Message for the user
	 */
	private finish(record: SessionRecord, state: LoginSessionState, message: string): void {
		if (isTerminalLoginState(record.session.state)) return;
		if (record.timer) clearTimeout(record.timer);
		record.timer = null;
		if (record.failureTimer) clearTimeout(record.failureTimer);
		record.failureTimer = null;
		record.finishedAt = this.now();
		this.update(record, { state, message, needsInput: false });
		if (record.pty && !record.exited) {
			try {
				record.pty.kill();
			} catch {
				// Already gone.
			}
		}
		this.logger.info('Login broker session finished', {
			sessionId: record.session.id,
			harnessId: record.session.harnessId,
			state,
			// Why it failed, redacted — without it a failed login is undiagnosable.
			...(state === 'failed' ? { message: this.safeMessage(record, message) } : {}),
		});
		const snapshot = { ...record.session };
		record.resolveDone(snapshot);
		this.emit(LOGIN_BROKER_EVENTS.FINISHED, snapshot);
	}

	/**
	 * Apply a patch, bump `updatedAt` and emit `update`.
	 *
	 * @param record - Session record
	 * @param patch - Fields to change
	 */
	private update(record: SessionRecord, patch: Partial<LoginSession>): void {
		record.session = { ...record.session, ...patch, updatedAt: new Date(this.now()).toISOString() };
		this.emit(LOGIN_BROKER_EVENTS.UPDATE, { ...record.session });
	}

	/**
	 * A user-facing message made safe for logs: secrets redacted, one line, bounded.
	 *
	 * @param record - Session record
	 * @param message - Message
	 * @returns Redacted message
	 */
	private safeMessage(record: SessionRecord, message: string): string {
		const oneLine = redactSecrets(message, record.secrets).replace(/\s+/g, ' ').trim();
		const max = HARNESS_CONSTANTS.LOGIN.LOG_MESSAGE_MAX_CHARS;
		return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
	}

	/**
	 * Tail of the screen, secrets redacted.
	 *
	 * @param record - Session record
	 * @param text - Normalized text
	 * @returns Exposed screen text
	 */
	private exposedScreen(record: SessionRecord, text: string): string {
		const redacted = redactSecrets(text, record.secrets);
		const max = HARNESS_CONSTANTS.LOGIN.SCREEN_MAX_CHARS;
		return redacted.length > max ? redacted.slice(redacted.length - max) : redacted;
	}

	/** Forget finished sessions older than the retention window. */
	private prune(): void {
		const cutoff = this.now() - HARNESS_CONSTANTS.LOGIN.SESSION_RETENTION_MS;
		for (const [id, record] of this.sessions) {
			if (record.finishedAt !== null && record.finishedAt < cutoff) this.sessions.delete(id);
		}
	}
}

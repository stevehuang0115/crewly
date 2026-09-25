/**
 * Harness onboarding types — the shapes shared by the backend REST API
 * (`/api/harness`), the `crewly` CLI and the web setup page.
 *
 * A "harness" is an agent CLI Crewly drives in a PTY: Claude Code, Codex or
 * Gemini CLI. See specs/onboarding-harness-login.md for the contract.
 *
 * @module services/harness/harness.types
 */

import { HARNESS_CONSTANTS } from '../../constants.js';

/** Harness id — equal to the matching `RuntimeType` value. */
export type HarnessId = (typeof HARNESS_CONSTANTS.IDS)[keyof typeof HARNESS_CONSTANTS.IDS];

/** Every harness id, in display order. */
export const HARNESS_IDS: readonly HarnessId[] = Object.values(HARNESS_CONSTANTS.IDS);

/** How the owner can log in to a harness. */
export type LoginMethodId = 'subscription' | 'api_key' | 'device';

/** Every login method id. */
export const LOGIN_METHOD_IDS: readonly LoginMethodId[] = ['subscription', 'api_key', 'device'];

/**
 * How a front end drives a login method.
 * - `broker`: Crewly runs the harness's login command in a PTY (login broker)
 * - `api_key`: the owner pastes a key
 */
export type LoginMethodKind = 'broker' | 'api_key';

/** A login method as exposed over the API. */
export interface HarnessLoginMethod {
	id: LoginMethodId;
	label: string;
	kind: LoginMethodKind;
}

/** Login state reported for a harness. */
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

/** Status of one harness (`GET /api/harness`). */
export interface HarnessStatus {
	id: HarnessId;
	displayName: string;
	installed: boolean;
	version: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	loginState: LoginState;
	/** Where the login was found (never a secret), e.g. `crewly-subscription`, `macos-keychain` */
	loginSource: string | null;
	loginMethods: HarnessLoginMethod[];
}

/** A required system tool (only jq today). */
export interface SystemToolStatus {
	id: string;
	installed: boolean;
	installHint: string;
}

/**
 * A re-login over Slack that is waiting for the owner (Phase 2): Crewly
 * noticed the harness login expired and started a broker login session.
 */
export interface ReloginPending {
	harnessId: HarnessId;
	/** Login broker session the owner is asked to finish */
	sessionId: string;
	/** ISO timestamp the broker session started */
	startedAt: string;
}

/** One harness in `GET /api/harness`: its status plus any pending re-login. */
export interface HarnessOverviewEntry extends HarnessStatus {
	reloginPending: ReloginPending | null;
}

/** Body of `GET /api/harness`. */
export interface HarnessOverview {
	harnesses: HarnessOverviewEntry[];
	orcHarness: string | null;
	systemTools: SystemToolStatus[];
}

/** State of an install job. */
export type InstallJobState = 'running' | 'succeeded' | 'failed';

/** An install job (`GET /api/harness/install/:jobId`). */
export interface InstallJob {
	jobId: string;
	harnessId: HarnessId;
	state: InstallJobState;
	log: string;
	usedUserPrefix: boolean;
}

/** State of a login broker session. */
export type LoginSessionState =
	| 'starting'
	| 'awaiting_user'
	| 'verifying'
	| 'succeeded'
	| 'failed'
	| 'timed_out'
	| 'cancelled';

/** Terminal login states: the PTY is gone and the session no longer changes. */
export const TERMINAL_LOGIN_STATES: readonly LoginSessionState[] = ['succeeded', 'failed', 'timed_out', 'cancelled'];

/** A login broker session as exposed to front ends. Never contains a secret. */
export interface LoginSession {
	id: string;
	harnessId: HarnessId;
	method: LoginMethodId;
	state: LoginSessionState;
	url: string | null;
	userCode: string | null;
	/** True when the harness waits for the user to type/paste something (e.g. Claude's code) */
	needsInput: boolean;
	message: string | null;
	/** Tail of the normalized terminal text, secrets redacted */
	screen: string;
	startedAt: string;
	updatedAt: string;
}

/**
 * Whether a value is a known harness id.
 *
 * @param value - Candidate
 * @returns True for `claude-code`, `codex-cli` or `gemini-cli`
 */
export function isHarnessId(value: unknown): value is HarnessId {
	return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * Whether a value is a known login method id.
 *
 * @param value - Candidate
 * @returns True for `subscription`, `api_key` or `device`
 */
export function isLoginMethodId(value: unknown): value is LoginMethodId {
	return typeof value === 'string' && (LOGIN_METHOD_IDS as readonly string[]).includes(value);
}

/**
 * Whether a login state is terminal (the session will not change again).
 *
 * @param state - Login session state
 * @returns True for succeeded / failed / timed_out / cancelled
 */
export function isTerminalLoginState(state: LoginSessionState): boolean {
	return TERMINAL_LOGIN_STATES.includes(state);
}

/** Minimal logger the harness services accept (the CLI passes a silent one). */
export interface HarnessLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

/** A logger that drops everything (CLI default, tests). */
export const SILENT_HARNESS_LOGGER: HarnessLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	debug: () => undefined,
};

/** Result of running a command to completion. */
export interface CommandResult {
	/** Exit code; null when the process could not be started or was killed */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Spawn error message (ENOENT, timeout), when there was one */
	error?: string;
}

/** Options for {@link RunCommand}. */
export interface RunCommandOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Written to the child's stdin, then stdin is closed (used for API keys; never argv) */
	stdin?: string;
	/** Streaming output callback (install log) */
	onOutput?: (chunk: string) => void;
}

/** Runs a command without a shell and resolves when it exits. Never rejects. */
export type RunCommand = (command: string, args: readonly string[], options?: RunCommandOptions) => Promise<CommandResult>;

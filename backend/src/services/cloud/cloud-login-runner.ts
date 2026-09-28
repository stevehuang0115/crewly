/**
 * Runs `crewly cloud login` in a PTY on the owner's behalf.
 *
 * Same pattern as the harness login broker (login-broker.service.ts): spawn
 * the real login command in a wide PTY, normalize the screen, read the
 * sign-in link and code off it, type the owner's reply in when the command
 * asks for one, and report success / failure from the output and exit code.
 * The CLI does the rest itself — device pairing with crewly-auth, saving
 * `$CREWLY_HOME/cloud/config.json`, and `POST /api/cloud/connect` on this
 * backend.
 *
 * Secrets: the device-code flow prints no token. A reply typed into the PTY
 * (a pasted token in the `--paste` flow) is echoed by the terminal, so the
 * screen is never logged or exposed — only the link, the code and the state.
 *
 * @module services/cloud/cloud-login-runner
 */

import * as os from 'os';
import * as pty from 'node-pty';
import { CLOUD_DISCONNECT_NOTICE_CONSTANTS } from '../../../../config/constants.js';
import { normalizeTerminalOutput } from '../harness/login-rules.js';
import type { BrokerPty, BrokerPtySpawner } from '../harness/login-broker.service.js';

const C = CLOUD_DISCONNECT_NOTICE_CONSTANTS;

/** Where a CLI login run stands. */
export type CloudLoginState =
	| 'starting'
	| 'awaiting_user'
	| 'verifying'
	| 'succeeded'
	| 'failed'
	| 'expired'
	| 'timed_out'
	| 'cancelled';

/** Snapshot of a run (never contains the screen). */
export interface CloudLoginSnapshot {
	state: CloudLoginState;
	/** Approve page with the code filled in */
	url: string | null;
	/** Code shown on the approve page */
	userCode: string | null;
	/** The CLI is waiting for typed input */
	needsInput: boolean;
	/** Short reason for a failure (from the CLI's ✗ line) */
	message: string | null;
}

/** A live CLI login run. */
export interface CloudLoginHandle {
	/** Current snapshot */
	get(): CloudLoginSnapshot;
	/** Resolves once a link is shown, the run ends, or `timeoutMs` passes */
	waitForLink(timeoutMs: number): Promise<CloudLoginSnapshot>;
	/** Resolves when the run ends */
	done: Promise<CloudLoginSnapshot>;
	/** Type a reply followed by Enter */
	input(text: string): void;
	/** Kill the run */
	cancel(): void;
	/** Subscribe to changes */
	onChange(listener: (snapshot: CloudLoginSnapshot) => void): void;
}

/** Dependencies (injectable for tests). */
export interface CloudLoginRunnerDeps {
	/** Node executable (defaults to the running one — never trust PATH) */
	nodePath?: string;
	/** CLI entry script (`<package>/dist/cli/cli/src/index.js`) */
	cliEntry: string;
	env?: NodeJS.ProcessEnv;
	spawnPty?: BrokerPtySpawner;
	timeoutMs?: number;
}

/** Terminal states. */
const TERMINAL: ReadonlySet<CloudLoginState> = new Set(['succeeded', 'failed', 'expired', 'timed_out', 'cancelled']);

/** Lines the CLI prints once the login worked. */
const SUCCESS_PATTERNS = [/✓\s*Approved/, /✓\s*Connected to CrewlyAI Cloud/, /✓\s*Credentials saved/];

/** The pairing ran out before the owner approved. */
const EXPIRED_PATTERN = /link expired before it was approved/i;

/** A prompt waiting for typed input (paste flows). */
const INPUT_PROMPT_PATTERN = /(paste|enter)[^\n]*[:?]\s*$/i;

/** Approve-page code, e.g. ABCD-2345. */
const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/**
 * Pick the sign-in link off the screen: the approve page with the code filled
 * in when present, else the first link.
 *
 * @param text - Normalized screen
 * @param hyperlinks - OSC 8 link targets
 * @returns The link, or null
 */
export function extractLoginUrl(text: string, hyperlinks: string[] = []): string | null {
	const urls = [...hyperlinks, ...(text.match(/https?:\/\/[^\s)'"<>]+/g) ?? [])];
	if (urls.length === 0) return null;
	return urls.find((u) => /[?&]code=/.test(u)) ?? urls[0] ?? null;
}

/**
 * Read the run's state off the screen.
 *
 * @param screenText - Normalized screen
 * @param sinceInput - Normalized output after the last typed reply
 * @param hyperlinks - OSC 8 link targets
 * @returns Link, code, input prompt, success, expiry and the last ✗ line
 */
export function parseCloudLoginScreen(
	screenText: string,
	sinceInput: string,
	hyperlinks: string[] = [],
): { url: string | null; userCode: string | null; needsInput: boolean; succeeded: boolean; expired: boolean; failure: string | null } {
	const failureLines = screenText.split('\n').filter((l) => l.includes('✗'));
	const lastFailure = failureLines.length > 0 ? failureLines[failureLines.length - 1]!.replace(/^.*✗\s*/, '').trim() : null;
	return {
		url: extractLoginUrl(screenText, hyperlinks),
		userCode: screenText.match(USER_CODE_PATTERN)?.[1] ?? null,
		needsInput: INPUT_PROMPT_PATTERN.test(sinceInput.trimEnd()),
		succeeded: SUCCESS_PATTERNS.some((p) => p.test(screenText)),
		expired: EXPIRED_PATTERN.test(screenText),
		failure: lastFailure,
	};
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

/**
 * Environment for the CLI: the backend's own (CREWLY_HOME, CREWLY_CLOUD_URL
 * carry over), no colours, and no browser on this machine.
 *
 * @param env - Source environment
 * @returns String-only env map
 */
export function buildCloudLoginEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	out.BROWSER = 'true';
	out.TERM = 'xterm-256color';
	out.FORCE_COLOR = '0';
	out.NO_COLOR = '1';
	return out;
}

/**
 * Start `crewly cloud login --no-browser` in a PTY.
 *
 * @param deps - CLI location and injectables
 * @returns The run
 * @throws Error when the PTY cannot be spawned
 */
export function startCloudLogin(deps: CloudLoginRunnerDeps): CloudLoginHandle {
	const spawnPty = deps.spawnPty ?? defaultSpawnPty;
	const timeoutMs = deps.timeoutMs ?? C.LOGIN_TIMEOUT_MS;
	const listeners: Array<(s: CloudLoginSnapshot) => void> = [];
	let snapshot: CloudLoginSnapshot = { state: 'starting', url: null, userCode: null, needsInput: false, message: null };
	let raw = '';
	let inputOffset = 0;
	let exited = false;
	let resolveDone: (s: CloudLoginSnapshot) => void = () => undefined;
	const done = new Promise<CloudLoginSnapshot>((resolve) => {
		resolveDone = resolve;
	});

	const emit = (): void => {
		for (const l of listeners) {
			try {
				l({ ...snapshot });
			} catch {
				// A listener must not break the run
			}
		}
	};
	const update = (patch: Partial<CloudLoginSnapshot>): void => {
		const next = { ...snapshot, ...patch };
		const changed = (Object.keys(next) as Array<keyof CloudLoginSnapshot>).some((k) => next[k] !== snapshot[k]);
		snapshot = next;
		if (changed) emit();
	};

	let term: BrokerPty | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const finish = (state: CloudLoginState, message: string | null): void => {
		if (TERMINAL.has(snapshot.state)) return;
		if (timer) clearTimeout(timer);
		timer = null;
		update({ state, message, needsInput: false });
		if (term && !exited) {
			try {
				term.kill();
			} catch {
				// Already gone
			}
		}
		resolveDone({ ...snapshot });
	};

	const evaluate = (final: boolean, exitCode?: number): void => {
		if (TERMINAL.has(snapshot.state)) return;
		const screen = normalizeTerminalOutput(raw);
		const since = normalizeTerminalOutput(raw.slice(inputOffset)).text;
		const parsed = parseCloudLoginScreen(screen.text, since, screen.hyperlinks);
		const url = parsed.url ?? snapshot.url;
		const needsInput = parsed.needsInput && !final;
		let state = snapshot.state;
		if (!final && ((state === 'starting' && (url || needsInput)) || (state === 'verifying' && needsInput))) state = 'awaiting_user';
		// One update, so listeners never see the link without its state.
		update({ state, url, userCode: parsed.userCode ?? snapshot.userCode, needsInput });
		if (!final) return;
		if (exitCode === 0 && parsed.succeeded) finish('succeeded', null);
		else if (parsed.expired) finish('expired', parsed.failure);
		else finish('failed', parsed.failure ?? `crewly cloud login exited (code ${exitCode ?? 'unknown'})`);
	};

	term = spawnPty(deps.nodePath ?? process.execPath, [deps.cliEntry, ...C.CLI_LOGIN_ARGS], {
		cols: C.PTY_COLS,
		rows: C.PTY_ROWS,
		cwd: os.homedir(),
		env: buildCloudLoginEnv(deps.env ?? process.env),
	});
	term.onData((data) => {
		raw += data;
		if (raw.length > C.RAW_BUFFER_MAX_CHARS) {
			const drop = raw.length - C.RAW_BUFFER_MAX_CHARS;
			raw = raw.slice(drop);
			inputOffset = Math.max(0, inputOffset - drop);
		}
		evaluate(false);
	});
	term.onExit(({ exitCode }) => {
		exited = true;
		evaluate(true, exitCode);
	});
	timer = setTimeout(() => finish('timed_out', null), timeoutMs);
	timer.unref?.();

	return {
		get: () => ({ ...snapshot }),
		done,
		waitForLink: (ms) =>
			new Promise<CloudLoginSnapshot>((resolve) => {
				if (snapshot.url || TERMINAL.has(snapshot.state)) {
					resolve({ ...snapshot });
					return;
				}
				let settled = false;
				const settle = (): void => {
					if (settled) return;
					settled = true;
					clearTimeout(t);
					resolve({ ...snapshot });
				};
				const t = setTimeout(settle, ms);
				t.unref?.();
				listeners.push((s) => {
					if (s.url || TERMINAL.has(s.state)) settle();
				});
			}),
		input: (text) => {
			if (TERMINAL.has(snapshot.state) || exited || !term) return;
			inputOffset = raw.length;
			term.write(`${text.replace(/[\r\n]+/g, '')}\r`);
			update({ state: 'verifying', needsInput: false });
		},
		cancel: () => finish('cancelled', null),
		onChange: (listener) => {
			listeners.push(listener);
		},
	};
}

/**
 * Whether a run has ended.
 *
 * @param state - Run state
 * @returns True for a terminal state
 */
export function isCloudLoginFinished(state: CloudLoginState): boolean {
	return TERMINAL.has(state);
}

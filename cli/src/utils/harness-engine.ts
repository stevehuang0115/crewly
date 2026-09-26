/**
 * How the CLI reaches the harness engine.
 *
 * The CLI imports the backend's harness service directly (like `crewly
 * backup` and `crewly token` do), so `crewly onboard`, `crewly login` and
 * `crewly harness` work with no backend running — detection, install and the
 * orc choice are files and child processes, not server state.
 *
 * Login is the one exception. A login session is a live PTY; when the backend
 * is running, the CLI starts it *in the backend* over its loopback REST API
 * (`/api/harness`). The session then outlives the CLI and is the same one the
 * web setup page and the phone / portal (through the relay) see, so the owner
 * can finish it from wherever they are. With no backend, the broker runs
 * in-process and lives as long as the CLI command.
 *
 * @module cli/utils/harness-engine
 */

import axios from 'axios';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HARNESS_CONSTANTS } from '../../../backend/src/constants.js';
import { getCrewlyHomeId, getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';
import { getHarnessDefinition, getLoginMethod } from '../../../backend/src/services/harness/harness-registry.js';
import { resolveExecutable } from '../../../backend/src/services/harness/harness-exec.utils.js';
import { evaluateLoginRules, getLoginRules, normalizeTerminalOutput, redactSecrets } from '../../../backend/src/services/harness/login-rules.js';
import { SettingsService } from '../../../backend/src/services/settings/settings.service.js';
import { HarnessService, createHarnessService } from '../../../backend/src/services/harness/harness.service.js';
import { SILENT_HARNESS_LOGGER, type HarnessId, type LoginMethodId, type LoginSession, type LoginSessionState } from '../../../backend/src/services/harness/harness.types.js';
import { DEFAULT_WEB_PORT } from '../constants.js';

/** Minimal JSON HTTP client (injectable for tests). */
export type HttpJson = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** Drives a login session wherever it lives. */
export interface LoginDriver {
	/**
	 * `in-process` (dies with the CLI), `backend` (visible to web / phone) or
	 * `detached` (a background process that outlives the CLI; device-code
	 * logins only, see {@link createDetachedLoginDriver})
	 */
	readonly where: 'in-process' | 'backend' | 'detached';
	start(harnessId: HarnessId, method: string): Promise<LoginSession>;
	get(sessionId: string): Promise<LoginSession>;
	input(sessionId: string, text: string): Promise<LoginSession>;
	cancel(sessionId: string): Promise<LoginSession>;
}

/**
 * Default HTTP client (axios, never throws on HTTP status).
 *
 * @param method - HTTP method
 * @param url - Absolute URL
 * @param body - JSON body
 * @returns Status and parsed body
 */
export const defaultHttpJson: HttpJson = async (method, url, body) => {
	const response = await axios.request({ method, url, data: body, timeout: HARNESS_CONSTANTS.PROBE_TIMEOUT_MS, validateStatus: () => true });
	return { status: response.status, body: response.data };
};

/**
 * The local backend's port (`WEB_PORT` or the default).
 *
 * @param env - Environment
 * @returns Port number
 */
export function getBackendPort(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.WEB_PORT ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEB_PORT;
}

/**
 * Loopback base URL of the local backend (no API token needed on loopback).
 *
 * @param port - Backend port
 * @returns e.g. `http://localhost:8787`
 */
export function localBackendUrl(port: number = getBackendPort()): string {
	return `http://localhost:${port}`;
}

/**
 * Whether *this user's* backend answers `/health` on the port.
 *
 * Loopback needs no API token, so answering is not enough: on a shared
 * machine the port may belong to another Unix user's Crewly (e.g. a
 * production backend running as root on 8787). The backend reports the id of
 * the Crewly home it serves (`homeId`); only a backend serving this CLI's
 * home counts. A backend too old to report it does not count either — the
 * CLI then runs the login in-process, which is always safe.
 *
 * @param port - Backend port
 * @param http - HTTP client
 * @param homeId - This CLI's Crewly home id (tests)
 * @returns True when our own backend is up
 */
export async function isBackendRunning(
	port: number = getBackendPort(),
	http: HttpJson = defaultHttpJson,
	homeId: string = getCrewlyHomeId(),
): Promise<boolean> {
	try {
		const { status, body } = await http('GET', `${localBackendUrl(port)}/health`);
		return status === 200 && (body as { homeId?: unknown } | null)?.homeId === homeId;
	} catch {
		return false;
	}
}

/**
 * The harness engine for this CLI process: silent logger, and settings
 * written through a fresh SettingsService (the backend's singleton is not
 * in this process).
 *
 * @returns Harness service
 */
export function createCliHarnessService(): HarnessService {
	return createHarnessService({
		logger: SILENT_HARNESS_LOGGER,
		updateDefaultRuntime: async (harnessId) => {
			await new SettingsService().updateSettings({ general: { defaultRuntime: harnessId } });
		},
	});
}

/**
 * Login driver backed by an in-process broker.
 *
 * @param service - Harness service
 * @returns Driver
 */
export function createInProcessLoginDriver(service: HarnessService): LoginDriver {
	return {
		where: 'in-process',
		start: async (harnessId, method) => service.startLogin(harnessId, method),
		get: async (sessionId) => service.broker.get(sessionId),
		input: async (sessionId, text) => service.broker.input(sessionId, text),
		cancel: async (sessionId) => service.broker.cancel(sessionId),
	};
}

/**
 * Unwrap a `{ success, data | error }` response.
 *
 * @param response - HTTP response
 * @returns The data
 * @throws Error with the API's error message
 */
function unwrap(response: { status: number; body: unknown }): LoginSession {
	const body = (response.body ?? {}) as { success?: boolean; data?: LoginSession; error?: string };
	if (response.status >= 200 && response.status < 300 && body.success && body.data) return body.data;
	throw new Error(body.error ?? `Crewly returned HTTP ${response.status}`);
}

/**
 * Login driver backed by the running backend's REST API.
 *
 * @param baseUrl - Backend base URL
 * @param http - HTTP client
 * @returns Driver
 */
export function createBackendLoginDriver(baseUrl: string = localBackendUrl(), http: HttpJson = defaultHttpJson): LoginDriver {
	const api = `${baseUrl}/api/harness`;
	return {
		where: 'backend',
		start: async (harnessId, method) => unwrap(await http('POST', `${api}/${harnessId}/login`, { method, force: true })),
		get: async (sessionId) => unwrap(await http('GET', `${api}/login/${encodeURIComponent(sessionId)}`)),
		input: async (sessionId, text) => unwrap(await http('POST', `${api}/login/${encodeURIComponent(sessionId)}/input`, { text })),
		cancel: async (sessionId) => unwrap(await http('POST', `${api}/login/${encodeURIComponent(sessionId)}/cancel`)),
	};
}

/**
 * Pick the login driver: the backend's when it is running, else in-process.
 *
 * @param service - In-process harness service (fallback)
 * @param options - Port and HTTP client (tests)
 * @returns Driver
 */
export async function pickLoginDriver(
	service: HarnessService,
	options: { port?: number; http?: HttpJson; homeId?: string } = {},
): Promise<LoginDriver> {
	const port = options.port ?? getBackendPort();
	const http = options.http ?? defaultHttpJson;
	return (await isBackendRunning(port, http, options.homeId)) ? createBackendLoginDriver(localBackendUrl(port), http) : createInProcessLoginDriver(service);
}

/** Injectable pieces of {@link createDetachedLoginDriver} (tests). */
export interface DetachedLoginDeps {
	spawn?: (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string; logFd: number }) => ChildProcess;
	/** Environment for the login command (defaults to the broker's env: harness PATH, BROWSER=true, no API token) */
	env?: Record<string, string>;
	/** Directory for the login's output file (defaults to `<crewlyHome>/logs`) */
	logDir?: string;
	homeDir?: string;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	now?: () => number;
}

/** Default spawner: a new process group, output to the log file, not tied to this process. */
function spawnDetached(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string; logFd: number }): ChildProcess {
	const child = spawn(command, [...args], {
		env: options.env,
		cwd: options.cwd,
		detached: true,
		stdio: ['ignore', options.logFd, options.logFd],
	});
	child.unref();
	return child;
}

/**
 * Login driver that runs a device-code login as a background process which
 * outlives the CLI.
 *
 * Used by `--yes` when no backend of ours is running: an in-process broker
 * would have to keep the CLI waiting (up to 15 minutes) for the owner to
 * enter the code on a phone — an agent or installer running the command
 * would hit its own timeout and kill the login with it. Detached, the CLI
 * prints the link and code and returns; the harness finishes the login by
 * itself (Codex writes `$CODEX_HOME/auth.json`) and exits when the code is
 * used or expires.
 *
 * Only methods that need no typed reply qualify (no `inputPromptPattern`):
 * nothing is connected to the process's stdin.
 *
 * @param service - Harness service (for the broker's env)
 * @param deps - Injectable pieces (tests)
 * @returns Driver
 */
export function createDetachedLoginDriver(service: HarnessService, deps: DetachedLoginDeps = {}): LoginDriver {
	const doSpawn = deps.spawn ?? spawnDetached;
	const now = deps.now ?? Date.now;
	const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
	const sessions = new Map<string, {
		harnessId: HarnessId;
		method: LoginMethodId;
		pid: number | undefined;
		logFile: string;
		startedAt: number;
		exited: boolean;
		spawnError: string | null;
		cancelled: boolean;
	}>();

	const snapshot = (id: string): LoginSession => {
		const record = sessions.get(id);
		if (!record) throw new Error(`No login session ${id}`);
		const rules = getLoginRules(record.harnessId, record.method);
		let raw = '';
		try {
			raw = fs.readFileSync(record.logFile, 'utf-8');
		} catch {
			// Not written yet.
		}
		const screen = normalizeTerminalOutput(raw);
		const match = rules ? evaluateLoginRules(rules, screen, { final: record.exited }) : null;
		let state: LoginSessionState;
		let message: string | null = null;
		if (record.cancelled) {
			state = 'cancelled';
		} else if (match?.failureMessage) {
			state = 'failed';
			message = match.failureMessage;
		} else if (match?.succeeded) {
			state = 'succeeded';
		} else if (record.exited) {
			state = 'failed';
			message = record.spawnError ?? 'The login command exited before showing a sign-in link.';
		} else {
			state = match?.url || match?.userCode ? 'awaiting_user' : 'starting';
		}
		return {
			id,
			harnessId: record.harnessId,
			method: record.method,
			state,
			url: match?.url ?? null,
			userCode: match?.userCode ?? null,
			needsInput: false,
			message,
			screen: redactSecrets(screen.text).slice(-HARNESS_CONSTANTS.LOGIN.SCREEN_MAX_CHARS),
			startedAt: new Date(record.startedAt).toISOString(),
			updatedAt: new Date(now()).toISOString(),
		};
	};

	return {
		where: 'detached',
		start: async (harnessId, method) => {
			const def = getHarnessDefinition(harnessId);
			const broker = getLoginMethod(harnessId, method)?.broker;
			const rules = getLoginRules(harnessId, method);
			if (!def || !broker || !rules) throw new Error(`${def?.displayName ?? harnessId} has no "${method}" sign-in that Crewly runs`);
			if (rules.inputPromptPattern) throw new Error(`${def.displayName}'s sign-in needs a code typed back; it cannot run in the background`);
			const env = deps.env ?? service.broker.buildEnv();
			const command = resolveExecutable(broker.command, env.PATH);
			if (!command) throw new Error(`${def.displayName} is not installed`);

			const logDir = deps.logDir ?? path.join(getCrewlyHomePath(), 'logs');
			fs.mkdirSync(logDir, { recursive: true });
			const logFile = path.join(logDir, `login-${harnessId}.log`);
			// Unlink rather than truncate: an earlier login may still be writing
			// to the old file, and must not scribble over this one.
			fs.rmSync(logFile, { force: true });
			const fd = fs.openSync(logFile, 'w', 0o600);
			const id = `detached-${randomUUID()}`;
			const record = { harnessId, method: method as LoginMethodId, pid: undefined as number | undefined, logFile, startedAt: now(), exited: false, spawnError: null as string | null, cancelled: false };
			sessions.set(id, record);
			try {
				const child = doSpawn(command, broker.args, { env, cwd: deps.homeDir ?? os.homedir(), logFd: fd });
				record.pid = child.pid;
				child.on('exit', () => { record.exited = true; });
				child.on('error', (error) => {
					record.exited = true;
					record.spawnError = error.message;
				});
			} finally {
				fs.closeSync(fd);
			}
			return snapshot(id);
		},
		get: async (sessionId) => snapshot(sessionId),
		input: async () => {
			throw new Error('A background sign-in takes no typed input');
		},
		cancel: async (sessionId) => {
			const record = sessions.get(sessionId);
			if (record && !record.exited && !record.cancelled && record.pid) {
				try {
					kill(-record.pid, 'SIGTERM'); // the whole process group
				} catch {
					try {
						kill(record.pid, 'SIGTERM');
					} catch {
						// Already gone.
					}
				}
			}
			if (record) record.cancelled = true;
			return snapshot(sessionId);
		},
	};
}

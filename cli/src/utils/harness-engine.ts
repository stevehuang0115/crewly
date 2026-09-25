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
import { HARNESS_CONSTANTS } from '../../../backend/src/constants.js';
import { SettingsService } from '../../../backend/src/services/settings/settings.service.js';
import { HarnessService, createHarnessService } from '../../../backend/src/services/harness/harness.service.js';
import { SILENT_HARNESS_LOGGER, type HarnessId, type LoginSession } from '../../../backend/src/services/harness/harness.types.js';
import { DEFAULT_WEB_PORT } from '../constants.js';

/** Minimal JSON HTTP client (injectable for tests). */
export type HttpJson = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** Drives a login session wherever it lives. */
export interface LoginDriver {
	/** `in-process` (dies with the CLI) or `backend` (visible to web / phone) */
	readonly where: 'in-process' | 'backend';
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
 * Whether the local backend answers `/health`.
 *
 * @param port - Backend port
 * @param http - HTTP client
 * @returns True when it is up
 */
export async function isBackendRunning(port: number = getBackendPort(), http: HttpJson = defaultHttpJson): Promise<boolean> {
	try {
		const { status } = await http('GET', `${localBackendUrl(port)}/health`);
		return status === 200;
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
		start: async (harnessId, method) => unwrap(await http('POST', `${api}/${harnessId}/login`, { method })),
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
	options: { port?: number; http?: HttpJson } = {},
): Promise<LoginDriver> {
	const port = options.port ?? getBackendPort();
	const http = options.http ?? defaultHttpJson;
	return (await isBackendRunning(port, http)) ? createBackendLoginDriver(localBackendUrl(port), http) : createInProcessLoginDriver(service);
}

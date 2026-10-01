/**
 * Upgrade / Restart API client.
 *
 * Uses `fetch` (the API-token guard installed in `main.tsx` adds the token
 * to same-origin calls). Owner actions carry `X-Crewly-Caller: dashboard`.
 *
 * @module services/system-control.service
 */

import { DASHBOARD_CALLER_HEADERS } from '../constants/caller.constants';
import {
	HEALTH_ENDPOINT,
	PROGRESS_REQUEST_TIMEOUT_MS,
	RESTART_ENDPOINT,
	UPDATE_STATUS_ENDPOINT,
	UPGRADE_ENDPOINT,
} from '../constants/system-control.constants';
import {
	SystemControlApiError,
	type SystemActionKind,
	type SystemActionRecord,
	type SystemActionWhen,
	type UpdateStatus,
} from '../types/system-control.types';

/** Server envelope. */
interface Envelope<T> {
	success?: boolean;
	data?: T;
	error?: string;
	code?: string;
}

/**
 * fetch with a timeout; network failures become status 0.
 *
 * @param url - URL
 * @param init - Options
 * @returns Response
 * @throws SystemControlApiError with status 0 when the server cannot be reached
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
	const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
	const timer = controller ? setTimeout(() => controller.abort(), PROGRESS_REQUEST_TIMEOUT_MS) : null;
	try {
		return await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
	} catch (error) {
		throw new SystemControlApiError(error instanceof Error ? error.message : 'Network error', 0);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Run a request and unwrap the envelope.
 *
 * @param url - URL
 * @param init - Options
 * @returns `data`
 * @throws SystemControlApiError on failure
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetchWithTimeout(url, init);
	let body: Envelope<T> = {};
	try {
		body = (await res.json()) as Envelope<T>;
	} catch {
		body = {};
	}
	if (!res.ok || body.success === false) {
		throw new SystemControlApiError(body.error || `HTTP ${res.status}`, res.status, body.code);
	}
	return body.data as T;
}

/**
 * Read the update status.
 *
 * @param refresh - Ask the npm registry again (cached answer older than a minute)
 * @returns Status
 */
export function fetchUpdateStatus(refresh = false): Promise<UpdateStatus> {
	return request<UpdateStatus>(`${UPDATE_STATUS_ENDPOINT}${refresh ? '?refresh=1' : ''}`);
}

/**
 * Start an upgrade or a restart.
 *
 * @param kind - upgrade or restart
 * @param when - idle or now
 * @returns The accepted action
 */
export async function startSystemAction(kind: SystemActionKind, when: SystemActionWhen): Promise<SystemActionRecord> {
	const data = await request<{ action: SystemActionRecord }>(kind === 'upgrade' ? UPGRADE_ENDPOINT : RESTART_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...DASHBOARD_CALLER_HEADERS },
		body: JSON.stringify({ when }),
	});
	return data.action;
}

/**
 * Whether the backend answers its health check.
 *
 * @returns True when it is up
 */
export async function isBackendUp(): Promise<boolean> {
	try {
		const res = await fetchWithTimeout(HEALTH_ENDPOINT);
		return res.ok;
	} catch {
		return false;
	}
}

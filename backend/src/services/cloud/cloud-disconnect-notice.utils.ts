/**
 * Cloud disconnect notice — pure rules.
 *
 * Detection ({@link evaluateDisconnect}), the notice rate limit
 * ({@link shouldNotify}), the owner-facing Chinese texts and the persisted
 * state file. No timers, no network: {@link CloudDisconnectNoticeService}
 * drives these.
 *
 * Background (2026-09-27): a second Mac stopped heart-beating to Crewly
 * Cloud and never reconnected, while its agents kept posting to Slack with
 * their own bot tokens. Inbound Slack only reaches a machine through Cloud →
 * relay, so every DM to its agents queued in Cloud for hours and nobody was
 * told.
 *
 * @module services/cloud/cloud-disconnect-notice.utils
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CloudSyncHealth } from './cloud-sync.types.js';

/** Why this machine cannot talk to Cloud. */
export type DisconnectReason = 'auth' | 'unreachable';

/** Inputs to {@link evaluateDisconnect}. */
export interface DisconnectInput {
	/** A Cloud config exists on disk (the machine was signed in and nobody logged out) */
	signedIn: boolean;
	/** CloudSyncService health */
	health: CloudSyncHealth;
	/** When the monitor started (epoch ms) — the baseline when sync never ran */
	monitorStartedAt: number;
	/** Now (epoch ms) */
	now: number;
	/** No successful Cloud request for this long = disconnected (ms) */
	thresholdMs: number;
}

/**
 * Result of {@link evaluateDisconnect}:
 * - `signed_out` — no Cloud config (never signed in, or logged out on purpose)
 * - `connected` — Cloud answered within the threshold
 * - `pending` — no answer yet since this start, still within the threshold
 * - `disconnected` — see `reason`; `since` is the last contact (or the start)
 */
export type DisconnectVerdict =
	| { status: 'signed_out' | 'connected' | 'pending' }
	| { status: 'disconnected'; reason: DisconnectReason; since: number };

/**
 * Decide whether this machine is disconnected from Cloud.
 *
 * Disconnected = signed in AND (sync is `auth_expired`, OR Cloud has not
 * answered a request for `thresholdMs`). Never fires on a machine that was
 * never signed in or was logged out on purpose — both leave no Cloud config.
 * `connected` needs a real answer from Cloud, so a restart that has not
 * reached Cloud yet reads `pending`, not `connected`.
 *
 * @param input - Sign-in, health, clock and threshold
 * @returns The verdict
 *
 * @example
 * ```ts
 * evaluateDisconnect({ signedIn: true, health: { state: 'auth_expired', lastContactAt: t0, startedAt: t0, authRejected: true },
 *   monitorStartedAt: t0, now: t0 + 60_000, thresholdMs: 900_000 });
 * // { status: 'disconnected', reason: 'auth', since: t0 }
 * ```
 */
export function evaluateDisconnect(input: DisconnectInput): DisconnectVerdict {
	const { signedIn, health, monitorStartedAt, now, thresholdMs } = input;
	if (!signedIn) return { status: 'signed_out' };
	const since = health.lastContactAt ?? health.startedAt ?? monitorStartedAt;
	if (health.state === 'auth_expired') return { status: 'disconnected', reason: 'auth', since };
	if (now - since < thresholdMs) return { status: health.lastContactAt !== null ? 'connected' : 'pending' };
	return { status: 'disconnected', reason: health.authRejected ? 'auth' : 'unreachable', since };
}

/** State persisted under the Crewly home so a restart does not re-notify. */
export interface DisconnectNoticeState {
	/** When this disconnect episode began (ISO) */
	episodeStartedAt: string;
	/** Last reason seen */
	reason: DisconnectReason;
	/** When the owner was last notified (ISO), null = not yet */
	lastNotifiedAt: string | null;
	/** Slack DM channel of the last notice (for edits and the follow-up) */
	channelId?: string;
	/** Slack ts of the last notice (for edits) */
	messageTs?: string;
	/** Whether the last notice carries a working login link */
	hasLink?: boolean;
	/** No further login runs before this time (ISO) — set after a failed login */
	loginBlockedUntil?: string;
}

/**
 * Whether a new notice may go out: none yet in this episode, or the last one
 * is at least `repeatMs` old.
 *
 * @param state - Persisted state (null = no episode yet)
 * @param now - Now (epoch ms)
 * @param repeatMs - Minimum gap between notices
 * @returns True when a notice may be sent
 */
export function shouldNotify(state: DisconnectNoticeState | null, now: number, repeatMs: number): boolean {
	if (!state?.lastNotifiedAt) return true;
	const last = Date.parse(state.lastNotifiedAt);
	if (Number.isNaN(last)) return true;
	return now - last >= repeatMs;
}

/**
 * Whether the notice is switched on (`CREWLY_CLOUD_DISCONNECT_NOTICE`).
 *
 * @param value - The env value
 * @returns False for `0`, `false`, `off`, `no`; true otherwise (default on)
 */
export function isNoticeEnabled(value: string | undefined): boolean {
	if (value === undefined) return true;
	return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

/**
 * Local time in the owner's reading format, e.g. `Sep 27 23:38`.
 *
 * @param ms - Epoch ms
 * @returns Local month/day hour:minute
 */
export function formatLocalTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Owner-facing reason text. */
const REASON_TEXT: Record<DisconnectReason, string> = {
	auth: 'the sign-in expired',
	unreachable: 'Cloud is unreachable from this network',
};

/** Inputs to {@link composeDisconnectNotice}. */
export interface DisconnectNoticeInput {
	/** This machine's name */
	deviceName: string;
	/** Why */
	reason: DisconnectReason;
	/** Episode start (epoch ms) */
	since: number;
	/** Re-login link (the approve page with the code filled in), when one is live */
	loginUrl?: string | null;
	/** Code shown on the approve page, when known */
	userCode?: string | null;
}

/**
 * The notice DMed to the owner.
 *
 * @param input - Device, reason, start time and the login link (if any)
 * @returns Plain text (the sender escapes it for Slack)
 *
 * @example
 * ```ts
 * composeDisconnectNotice({ deviceName: 'iriss-air.lan', reason: 'auth', since, loginUrl: 'https://crewlyai.com/cloud/pair?code=ABCD-2345' });
 * ```
 */
export function composeDisconnectNotice(input: DisconnectNoticeInput): string {
	const head =
		`Crewly (machine: ${input.deviceName}) lost its connection to Crewly Cloud (${REASON_TEXT[input.reason]}, since ${formatLocalTime(input.since)}). ` +
		'Slack messages to agents on this machine are queued in Cloud until it is back. ';
	if (input.loginUrl) {
		const code = input.userCode ? `; check code ${input.userCode}` : '';
		return `${head}Sign in again here: ${input.loginUrl} (one tap on your phone${code}). Queued messages are delivered once you are signed in.`;
	}
	if (input.reason === 'auth') {
		return `${head}No sign-in link yet. Crewly keeps trying and will update this message when it has one.`;
	}
	return `${head}Crewly keeps reconnecting on its own; queued messages are delivered once it is back.`;
}

/** Follow-up once the machine is back. */
export const RECONNECTED_NOTICE = 'Back on Crewly Cloud. Queued messages are being delivered.';

/**
 * Brief note when a re-login did not finish.
 *
 * @param detail - What happened (e.g. sign-in was denied)
 * @param retryAt - When the next link goes out (epoch ms)
 * @returns The note
 */
export function composeLoginFailedNotice(detail: string, retryAt: number): string {
	return `The sign-in did not finish (${detail}). Crewly will send a new link at ${formatLocalTime(retryAt)}.`;
}

/**
 * Read the persisted state.
 *
 * @param file - State file
 * @returns The state, or null when missing / unreadable
 */
export function readNoticeState(file: string): DisconnectNoticeState | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<DisconnectNoticeState>;
		if (typeof parsed.episodeStartedAt !== 'string') return null;
		return {
			episodeStartedAt: parsed.episodeStartedAt,
			reason: parsed.reason === 'auth' ? 'auth' : 'unreachable',
			lastNotifiedAt: typeof parsed.lastNotifiedAt === 'string' ? parsed.lastNotifiedAt : null,
			...(typeof parsed.channelId === 'string' ? { channelId: parsed.channelId } : {}),
			...(typeof parsed.messageTs === 'string' ? { messageTs: parsed.messageTs } : {}),
			...(typeof parsed.hasLink === 'boolean' ? { hasLink: parsed.hasLink } : {}),
			...(typeof parsed.loginBlockedUntil === 'string' ? { loginBlockedUntil: parsed.loginBlockedUntil } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Persist the state.
 *
 * @param file - State file
 * @param state - State to write
 */
export function writeNoticeState(file: string, state: DisconnectNoticeState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Remove the state (episode over).
 *
 * @param file - State file
 */
export function clearNoticeState(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		// Already gone
	}
}

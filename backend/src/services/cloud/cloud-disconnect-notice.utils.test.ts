/**
 * Tests for the Cloud disconnect notice rules: detection, rate limit, kill
 * switch, owner-facing texts and the state file.
 *
 * @module services/cloud/cloud-disconnect-notice.utils.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudSyncHealth } from './cloud-sync.types.js';
import {
	RECONNECTED_NOTICE,
	clearNoticeState,
	composeDisconnectNotice,
	composeLoginFailedNotice,
	describeQueueError,
	evaluateDisconnect,
	formatLocalTime,
	isNoticeEnabled,
	readLastRelayQueueNotice,
	readNoticeState,
	shouldNotify,
	writeLastRelayQueueNotice,
	writeNoticeState,
} from './cloud-disconnect-notice.utils.js';

const MIN = 60_000;
const THRESHOLD = 15 * MIN;
const T0 = new Date(2026, 8, 27, 23, 38).getTime();

/**
 * Health snapshot with defaults.
 *
 * @param patch - Fields to override
 * @returns Health
 */
function health(patch: Partial<CloudSyncHealth> = {}): CloudSyncHealth {
	return { state: 'syncing', lastContactAt: T0, startedAt: T0, authRejected: false, ...patch };
}

describe('evaluateDisconnect', () => {
	const base = { signedIn: true, monitorStartedAt: T0, thresholdMs: THRESHOLD };

	it('never fires when there is no Cloud config (never signed in or logged out)', () => {
		expect(evaluateDisconnect({ ...base, signedIn: false, health: health({ state: 'auth_expired' }), now: T0 + 10 * 60 * MIN })).toEqual({
			status: 'signed_out',
		});
		expect(evaluateDisconnect({ ...base, signedIn: false, health: health({ state: 'stopped', lastContactAt: null, startedAt: null }), now: T0 + 60 * MIN }).status).toBe(
			'signed_out',
		);
	});

	it('fires at once on auth_expired, reason auth', () => {
		expect(evaluateDisconnect({ ...base, health: health({ state: 'auth_expired' }), now: T0 + MIN })).toEqual({
			status: 'disconnected',
			reason: 'auth',
			since: T0,
		});
	});

	it('is connected while Cloud answered within the threshold', () => {
		expect(evaluateDisconnect({ ...base, health: health({ lastContactAt: T0 }), now: T0 + 14 * MIN }).status).toBe('connected');
	});

	it('fires after 15 minutes of silence; reason follows the last auth refusal', () => {
		expect(evaluateDisconnect({ ...base, health: health({ state: 'error' }), now: T0 + THRESHOLD })).toEqual({
			status: 'disconnected',
			reason: 'unreachable',
			since: T0,
		});
		expect(evaluateDisconnect({ ...base, health: health({ state: 'error', authRejected: true }), now: T0 + THRESHOLD }).status).toBe('disconnected');
		expect(evaluateDisconnect({ ...base, health: health({ state: 'error', authRejected: true }), now: T0 + THRESHOLD })).toMatchObject({ reason: 'auth' });
	});

	it('reads pending (not connected) after a restart that has not reached Cloud yet', () => {
		const h = health({ lastContactAt: null, startedAt: T0 });
		expect(evaluateDisconnect({ ...base, health: h, now: T0 + 5 * MIN }).status).toBe('pending');
		expect(evaluateDisconnect({ ...base, health: h, now: T0 + THRESHOLD }).status).toBe('disconnected');
	});

	it('falls back to the monitor start when sync never started', () => {
		const h = health({ state: 'stopped', lastContactAt: null, startedAt: null });
		expect(evaluateDisconnect({ ...base, health: h, now: T0 + THRESHOLD })).toEqual({ status: 'disconnected', reason: 'unreachable', since: T0 });
	});
});

describe('shouldNotify', () => {
	const REPEAT = 6 * 60 * MIN;
	it('allows the first notice of an episode', () => {
		expect(shouldNotify(null, T0, REPEAT)).toBe(true);
		expect(shouldNotify({ episodeStartedAt: 'x', reason: 'auth', lastNotifiedAt: null }, T0, REPEAT)).toBe(true);
	});
	it('holds repeats for 6 hours', () => {
		const state = { episodeStartedAt: 'x', reason: 'auth' as const, lastNotifiedAt: new Date(T0).toISOString() };
		expect(shouldNotify(state, T0 + REPEAT - 1, REPEAT)).toBe(false);
		expect(shouldNotify(state, T0 + REPEAT, REPEAT)).toBe(true);
	});
});

describe('isNoticeEnabled', () => {
	it('is on by default and off for 0/false/off/no', () => {
		expect(isNoticeEnabled(undefined)).toBe(true);
		expect(isNoticeEnabled('1')).toBe(true);
		for (const v of ['0', 'false', 'OFF', ' no ']) expect(isNoticeEnabled(v)).toBe(false);
	});
});

describe('notice texts', () => {
	it('formats local time as Mon D HH:mm', () => {
		expect(formatLocalTime(new Date(2026, 8, 7, 5, 3).getTime())).toBe('Sep 7 05:03');
	});

	it('includes device, reason, start time, link and code', () => {
		const text = composeDisconnectNotice({
			deviceName: 'iriss-air.lan',
			reason: 'auth',
			since: T0,
			loginUrl: 'https://portal.example.test/cloud/pair?code=ABCD-2345',
			userCode: 'ABCD-2345',
		});
		expect(text).toBe(
			'Crewly (machine: iriss-air.lan) lost its connection to Crewly Cloud (the sign-in expired, since Sep 27 23:38). ' +
				'Slack messages to agents on this machine are queued in Cloud until it is back. ' +
				'Sign in again here: https://portal.example.test/cloud/pair?code=ABCD-2345 (one tap on your phone; check code ABCD-2345). Queued messages are delivered once you are signed in.',
		);
	});

	it('says it keeps retrying when no link could be had', () => {
		expect(composeDisconnectNotice({ deviceName: 'm', reason: 'auth', since: T0 })).toContain('No sign-in link yet. Crewly keeps trying');
		const unreachable = composeDisconnectNotice({ deviceName: 'm', reason: 'unreachable', since: T0 });
		expect(unreachable).toContain('Cloud is unreachable');
		expect(unreachable).toContain('Crewly keeps reconnecting');
		expect(unreachable).not.toContain('http');
	});

	it('has the follow-up and the failure note', () => {
		expect(RECONNECTED_NOTICE).toBe('Back on Crewly Cloud. Queued messages are being delivered.');
		expect(composeLoginFailedNotice('sign-in was denied', new Date(2026, 8, 28, 5, 38).getTime())).toBe(
			'The sign-in did not finish (sign-in was denied). Crewly will send a new link at Sep 28 05:38.',
		);
	});
});

describe('state file', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-state-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('round-trips, tolerates garbage, and clears', () => {
		const file = path.join(dir, 'cloud', 'disconnect-notice.json');
		expect(readNoticeState(file)).toBeNull();
		const state = {
			episodeStartedAt: new Date(T0).toISOString(),
			reason: 'auth' as const,
			lastNotifiedAt: new Date(T0).toISOString(),
			channelId: 'D1',
			messageTs: '1.2',
			hasLink: true,
		};
		writeNoticeState(file, state);
		expect(readNoticeState(file)).toEqual(state);
		fs.writeFileSync(file, 'not json');
		expect(readNoticeState(file)).toBeNull();
		clearNoticeState(file);
		clearNoticeState(file);
		expect(fs.existsSync(file)).toBe(false);
	});
});

// 2026-10-02: heartbeats kept succeeding while the relay answered every queue
// registration with 429 quota_exceeded — the 15-min "no contact" rule called
// the machine connected while it received nothing for half an hour.
describe('relay queue registration failures', () => {
	const base = { signedIn: true, monitorStartedAt: T0, thresholdMs: THRESHOLD, queueThresholdMs: 2 * MIN };
	const QUOTA_ERROR = 'Queue registration failed: 429 {"success":false,"error":"quota_exceeded","limit":8,"current":8}';
	const failing = (patch: Partial<NonNullable<CloudSyncHealth['relayQueue']>> = {}): CloudSyncHealth =>
		health({
			relayQueue: { queueId: null, error: QUOTA_ERROR, failingSince: T0, failures: 3, nextAttemptAt: T0 + 2 * MIN, ...patch },
		});

	it('is pending for the first two minutes of failure, even with fresh contact', () => {
		expect(evaluateDisconnect({ ...base, health: failing(), now: T0 + MIN + 59_000 }).status).toBe('pending');
	});

	it('is disconnected after two minutes, reason relay_queue, with the reason spelled out', () => {
		expect(evaluateDisconnect({ ...base, health: failing(), now: T0 + 2 * MIN })).toEqual({
			status: 'disconnected',
			reason: 'relay_queue',
			since: T0,
			detail: 'relay quota full',
		});
	});

	it('defaults the threshold to two minutes', () => {
		const { queueThresholdMs: _omit, ...noQueueThreshold } = base;
		expect(evaluateDisconnect({ ...noQueueThreshold, health: failing(), now: T0 + 2 * MIN }).status).toBe('disconnected');
	});

	it('does not fire while a queue registered earlier is still held (only the keep-alive is failing)', () => {
		const held = { ...failing({ queueId: 'q-held' }), lastContactAt: T0 + 59 * MIN };
		expect(evaluateDisconnect({ ...base, health: held, now: T0 + 60 * MIN }).status).toBe('connected');
	});

	it('is connected once registration succeeds', () => {
		expect(
			evaluateDisconnect({ ...base, health: failing({ queueId: 'q-1', error: null, failingSince: null, failures: 0 }), now: T0 + 5 * MIN }).status,
		).toBe('connected');
	});

	it('leaves auth_expired as the reason when the sign-in is gone', () => {
		expect(evaluateDisconnect({ ...base, health: { ...failing(), state: 'auth_expired' }, now: T0 + 5 * MIN })).toMatchObject({ reason: 'auth' });
	});

	it('describes registration errors for the owner', () => {
		expect(describeQueueError(QUOTA_ERROR)).toBe('relay quota full');
		expect(describeQueueError('Queue registration failed: 429 {"error":"rate_limited"}')).toBe('the relay is rate-limiting this account');
		expect(describeQueueError('Queue registration failed: 403 Not authorized')).toBe('the relay queue belongs to another account');
		expect(describeQueueError('Queue registration failed: 502 Bad Gateway')).toBe('the relay is returning errors');
		expect(describeQueueError('fetch failed')).toBe('relay registration keeps failing');
		expect(describeQueueError(null)).toBe('relay registration keeps failing');
	});

	it('composes the owner notice in English', () => {
		const text = composeDisconnectNotice({ deviceName: 'macbookpro.lan', reason: 'relay_queue', since: T0, detail: 'relay quota full' });
		expect(text).toBe(
			"This machine (macbookpro.lan) can't connect to Crewly Cloud (relay quota full) — Slack messages won't arrive here until it does. " +
				`Failing since ${formatLocalTime(T0)}; Crewly keeps retrying on its own.`,
		);
	});

	it('round-trips relay_queue and quiet through the state file, and the last-notice sidecar', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-notice-'));
		try {
			const file = path.join(dir, 'cloud', 'disconnect-notice.json');
			writeNoticeState(file, { episodeStartedAt: new Date(T0).toISOString(), reason: 'relay_queue', lastNotifiedAt: null, quiet: true });
			expect(readNoticeState(file)).toMatchObject({ reason: 'relay_queue', quiet: true });

			const sidecar = path.join(dir, 'cloud', 'relay-queue-notice.json');
			expect(readLastRelayQueueNotice(sidecar)).toBeNull();
			writeLastRelayQueueNotice(sidecar, T0);
			expect(readLastRelayQueueNotice(sidecar)).toBe(T0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

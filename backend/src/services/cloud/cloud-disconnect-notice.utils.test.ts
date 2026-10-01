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
	evaluateDisconnect,
	formatLocalTime,
	isNoticeEnabled,
	readNoticeState,
	shouldNotify,
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

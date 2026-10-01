/**
 * Tests for the Cloud disconnect notice service with mocked collaborators:
 * detection → DM with the CLI login link, rate limit across restarts,
 * login success → reconnect + follow-up, failure → brief note, expired link
 * → edited in place, CLI asking for input → owner's DM reply typed in,
 * logout / never signed in → silence, Slack not configured → log only.
 *
 * @module services/cloud/cloud-disconnect-notice.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OwnerDirectDm, OwnerDmReply } from '../slack/slack-owner-direct-dm.js';
import type { CloudLoginHandle, CloudLoginSnapshot } from './cloud-login-runner.js';
import type { CloudSyncHealth } from './cloud-sync.types.js';
import { CloudDisconnectNoticeService, type CloudDisconnectNoticeDeps } from './cloud-disconnect-notice.service.js';
import { readNoticeState, writeNoticeState } from './cloud-disconnect-notice.utils.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = new Date(2026, 8, 27, 15, 38).getTime();
const LINK = 'https://portal.example.test/cloud/pair?code=ABCD-2345';

/** A CLI login run the test drives by hand. */
class FakeLogin implements CloudLoginHandle {
	snapshot: CloudLoginSnapshot = { state: 'starting', url: null, userCode: null, needsInput: false, message: null };
	inputs: string[] = [];
	cancelled = false;
	private listeners: Array<(s: CloudLoginSnapshot) => void> = [];
	private resolveDone!: (s: CloudLoginSnapshot) => void;
	done = new Promise<CloudLoginSnapshot>((resolve) => {
		this.resolveDone = resolve;
	});
	get(): CloudLoginSnapshot {
		return { ...this.snapshot };
	}
	async waitForLink(): Promise<CloudLoginSnapshot> {
		return this.get();
	}
	input(text: string): void {
		this.inputs.push(text);
		this.set({ state: 'verifying', needsInput: false });
	}
	cancel(): void {
		this.cancelled = true;
		this.end({ state: 'cancelled' });
	}
	onChange(listener: (s: CloudLoginSnapshot) => void): void {
		this.listeners.push(listener);
	}
	set(patch: Partial<CloudLoginSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const l of this.listeners) l(this.get());
	}
	end(patch: Partial<CloudLoginSnapshot>): void {
		if (['succeeded', 'failed', 'expired', 'timed_out', 'cancelled'].includes(this.snapshot.state)) return;
		this.set(patch);
		this.resolveDone(this.get());
	}
}

/** Recorded DM operations. */
class FakeDm implements OwnerDirectDm {
	sent: string[] = [];
	updates: Array<{ channelId: string; ts: string; text: string }> = [];
	replies: OwnerDmReply[] = [];
	failSend = false;
	failUpdate = false;
	private n = 0;
	async send(text: string) {
		if (this.failSend) throw new Error('channel_not_found');
		this.sent.push(text);
		this.n += 1;
		return { channelId: 'D-OWNER', ts: `${1000 + this.n}.000` };
	}
	async update(channelId: string, ts: string, text: string) {
		if (this.failUpdate) throw new Error('message_not_found');
		this.updates.push({ channelId, ts, text });
	}
	async readOwnerReplies(_channelId: string, afterTs: string) {
		return this.replies.filter((r) => Number(r.ts) > Number(afterTs));
	}
}

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe('CloudDisconnectNoticeService', () => {
	let dir: string;
	let stateFile: string;
	let now: number;
	let health: CloudSyncHealth;
	let signedIn: boolean;
	let dm: FakeDm | null;
	let logins: FakeLogin[];
	let startLogin: jest.Mock;
	let reconnect: jest.Mock;
	let scheduled: Array<{ fn: () => void; ms: number }>;
	let logger: { info: jest.Mock; warn: jest.Mock };

	/**
	 * Build a service with the current test state.
	 *
	 * @param patch - Dep overrides
	 * @returns Started service
	 */
	function makeService(patch: Partial<CloudDisconnectNoticeDeps> = {}): CloudDisconnectNoticeService {
		const service = new CloudDisconnectNoticeService({
			stateFile,
			isSignedIn: async () => signedIn,
			getHealth: () => health,
			getDeviceName: async () => 'iriss-air.lan',
			getDm: () => dm,
			startLogin,
			reconnect,
			logger,
			now: () => now,
			schedule: (fn, ms) => {
				const entry = { fn, ms };
				scheduled.push(entry);
				return entry;
			},
			cancel: (handle) => {
				scheduled = scheduled.filter((e) => e !== handle);
			},
			...patch,
		});
		service.start();
		return service;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-svc-'));
		stateFile = path.join(dir, 'cloud', 'disconnect-notice.json');
		now = T0;
		health = { state: 'syncing', lastContactAt: T0, startedAt: T0, authRejected: false };
		signedIn = true;
		dm = new FakeDm();
		logins = [];
		startLogin = jest.fn(() => {
			const login = new FakeLogin();
			login.snapshot = { ...login.snapshot, state: 'awaiting_user', url: LINK, userCode: 'ABCD-2345' };
			logins.push(login);
			return login;
		});
		reconnect = jest.fn(async () => true);
		scheduled = [];
		logger = { info: jest.fn(), warn: jest.fn() };
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('stays quiet while connected, while pending, when never signed in, and when logged out', async () => {
		const service = makeService();
		now = T0 + 10 * MIN;
		await service.tick();
		health = { state: 'syncing', lastContactAt: null, startedAt: T0, authRejected: false };
		await service.tick();
		signedIn = false;
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		now = T0 + 5 * HOUR;
		await service.tick();
		expect(dm!.sent).toEqual([]);
		expect(startLogin).not.toHaveBeenCalled();
		expect(readNoticeState(stateFile)).toBeNull();
		service.stop();
	});

	it('on auth_expired: runs the CLI login and DMs the owner the link, once', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		now = T0 + 6 * MIN;
		await service.tick();

		expect(startLogin).toHaveBeenCalledTimes(1);
		expect(dm!.sent).toHaveLength(1);
		expect(dm!.sent[0]).toContain('Crewly (machine: iriss-air.lan) lost its connection to Crewly Cloud (the sign-in expired, since Sep 27 15:38)');
		expect(dm!.sent[0]).toContain(`Sign in again here: ${LINK}`);
		expect(readNoticeState(stateFile)).toMatchObject({ channelId: 'D-OWNER', messageTs: '1001.000', hasLink: true, reason: 'auth' });

		now += 5 * HOUR;
		await service.tick();
		expect(dm!.sent).toHaveLength(1);
		expect(startLogin).toHaveBeenCalledTimes(1);
		service.stop();
	});

	it('does not re-notify after a restart, but repeats after 6 hours', async () => {
		health = { state: 'error', lastContactAt: T0, startedAt: T0, authRejected: false };
		now = T0 + 20 * MIN;
		const first = makeService();
		await first.tick();
		expect(dm!.sent).toHaveLength(1);
		expect(dm!.sent[0]).toContain('Cloud is unreachable');
		expect(startLogin).not.toHaveBeenCalled();
		first.stop();

		// Restart: new process, sync never reached Cloud again.
		health = { state: 'error', lastContactAt: null, startedAt: now, authRejected: false };
		now += 30 * MIN;
		const second = makeService();
		await second.tick();
		expect(dm!.sent).toHaveLength(1);

		now = T0 + 20 * MIN + 6 * HOUR;
		await second.tick();
		expect(dm!.sent).toHaveLength(2);
		// The repeat keeps the original episode start.
		expect(dm!.sent[1]).toContain('since Sep 27 15:38');
		second.stop();
	});

	it('login success → reconnect → follow-up, and the episode is closed', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		now = T0 + MIN;
		await service.tick();
		logins[0]!.end({ state: 'succeeded' });
		await flush();

		expect(reconnect).toHaveBeenCalledTimes(1);
		expect(dm!.sent[1]).toBe('Back on Crewly Cloud. Queued messages are being delivered.');
		expect(readNoticeState(stateFile)).toBeNull();

		health = { state: 'syncing', lastContactAt: now, startedAt: now, authRejected: false };
		await service.tick();
		expect(dm!.sent).toHaveLength(2);
		service.stop();
	});

	it('reconnecting by any other path also sends the follow-up (once)', async () => {
		const service = makeService();
		health = { state: 'error', lastContactAt: T0, startedAt: T0, authRejected: false };
		now = T0 + 16 * MIN;
		await service.tick();
		health = { state: 'syncing', lastContactAt: now + MIN, startedAt: T0, authRejected: false };
		now += 2 * MIN;
		await service.tick();
		await service.tick();
		expect(dm!.sent).toEqual([expect.stringContaining('lost its connection'), 'Back on Crewly Cloud. Queued messages are being delivered.']);
		service.stop();
	});

	it('logging out mid-episode ends it silently and stops the login', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		signedIn = false;
		await service.tick();
		await flush();
		expect(logins[0]!.cancelled).toBe(true);
		expect(dm!.sent).toHaveLength(1);
		expect(readNoticeState(stateFile)).toBeNull();
		service.stop();
	});

	it('login failure → one brief note, no new login until the next window', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		logins[0]!.end({ state: 'failed', message: 'The request was denied on crewlyai.com.' });
		await flush();
		expect(dm!.sent[1]).toBe('The sign-in did not finish (sign-in was denied). Crewly will send a new link at Sep 27 21:38.');

		now += 3 * HOUR;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(1);
		expect(dm!.sent).toHaveLength(2);

		now = T0 + 6 * HOUR;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(2);
		expect(dm!.sent).toHaveLength(3);
		expect(dm!.sent[2]).toContain(LINK);
		service.stop();
	});

	it('an expired link is replaced by editing the notice (no new message)', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		logins[0]!.end({ state: 'expired' });
		await flush();
		expect(dm!.sent).toHaveLength(1);

		now += 16 * MIN;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(2);
		expect(dm!.updates).toEqual([{ channelId: 'D-OWNER', ts: '1001.000', text: expect.stringContaining(LINK) }]);
		expect(dm!.sent).toHaveLength(1);
		service.stop();
	});

	it('when the CLI cannot start: notice without a link, then the link is edited in on a later retry', async () => {
		startLogin.mockImplementationOnce(() => {
			throw new Error('crewly CLI not found');
		});
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		expect(dm!.sent[0]).toContain('No sign-in link yet. Crewly keeps trying');
		expect(readNoticeState(stateFile)).toMatchObject({ hasLink: false });

		now += MIN;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(1);

		now += 5 * MIN;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(2);
		expect(dm!.updates[0]!.text).toContain(LINK);
		expect(dm!.sent).toHaveLength(1);
		service.stop();
	});

	it('a failed edit falls back to a brief note and waits for the next window', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		logins[0]!.end({ state: 'expired' });
		await flush();
		dm!.failUpdate = true;
		now += 16 * MIN;
		await service.tick();
		expect(dm!.sent[1]).toContain('The sign-in did not finish (the link expired)');
		now += 30 * MIN;
		await service.tick();
		expect(startLogin).toHaveBeenCalledTimes(2);
		service.stop();
	});

	it('types the owner’s DM reply into the CLI when it asks for input', async () => {
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		const login = logins[0]!;
		login.set({ needsInput: true });
		expect(scheduled.some((e) => e.ms === 5000)).toBe(true);

		// Nothing yet: keeps polling.
		scheduled.find((e) => e.ms === 5000)!.fn();
		await flush();
		expect(login.inputs).toEqual([]);

		dm!.replies = [{ ts: '1002.000', text: 'code-from-owner' }];
		const next = scheduled.filter((e) => e.ms === 5000).pop()!;
		next.fn();
		await flush();
		expect(login.inputs).toEqual(['code-from-owner']);
		// The reply text is never logged.
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain('code-from-owner');
		service.stop();
	});

	it('Slack not configured: logs only, once per window', async () => {
		dm = null;
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		await service.tick();
		expect(startLogin).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn.mock.calls[0]![0]).toContain('Slack is not configured');
		service.stop();
	});

	it('a Slack send failure is retried on the next check, not counted as notified', async () => {
		dm!.failSend = true;
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: T0, startedAt: T0, authRejected: true };
		await service.tick();
		expect(readNoticeState(stateFile)).toMatchObject({ lastNotifiedAt: null });
		dm!.failSend = false;
		await service.tick();
		expect(dm!.sent).toHaveLength(1);
		// The live login run was reused, not restarted.
		expect(startLogin).toHaveBeenCalledTimes(1);
		service.stop();
	});

	it('schedules checks every minute and stops cleanly', () => {
		const service = makeService();
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.ms).toBe(60_000);
		service.stop();
		expect(scheduled).toHaveLength(0);
	});

	it('keeps a persisted episode from a previous boot', async () => {
		writeNoticeState(stateFile, {
			episodeStartedAt: new Date(T0 - HOUR).toISOString(),
			reason: 'auth',
			lastNotifiedAt: new Date(T0 - HOUR).toISOString(),
			channelId: 'D-OWNER',
			messageTs: '999.000',
			hasLink: true,
		});
		const service = makeService();
		health = { state: 'auth_expired', lastContactAt: null, startedAt: T0, authRejected: true };
		await service.tick();
		// No new message; the old link died with the old process, so it is replaced in place.
		expect(dm!.sent).toHaveLength(0);
		expect(dm!.updates[0]).toMatchObject({ ts: '999.000', text: expect.stringContaining(LINK) });
		service.stop();
	});
});

/**
 * Tests for the liveness monitor (crewly#1015 §12).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LIVENESS_MONITOR_CONSTANTS as C } from '../../constants.js';
import { LivenessMonitorService, formatDuration, livenessAlertText } from './liveness-monitor.service.js';

const MIN = 60 * 1000;
// 2026-10-01 09:50 ET
const T0 = Date.UTC(2026, 9, 1, 13, 50);

describe('LivenessMonitorService', () => {
	let dir: string;
	let storePath: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
		storePath = path.join(dir, 'liveness.json');
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function monitor(clock: { t: number }, sent: string[], opts: { pid?: number; delivered?: () => boolean } = {}) {
		return new LivenessMonitorService({
			storePath,
			notifyOwner: async (text) => {
				if (opts.delivered && !opts.delivered()) return false;
				sent.push(text);
				return true;
			},
			machineName: () => 'Mac',
			now: () => clock.t,
			pid: opts.pid ?? 200,
			timeZone: 'America/New_York',
		});
	}

	it('a long gap between ticks (asleep / stuck) is told to the owner once', async () => {
		const clock = { t: T0 };
		const sent: string[] = [];
		const m = monitor(clock, sent);
		m.start();
		m.stop();
		clock.t += C.TICK_MS;
		m.tick();
		clock.t += 4 * 60 * MIN + 49 * MIN; // back at 14:39 ET
		m.tick();
		await new Promise((r) => setImmediate(r));
		expect(sent).toEqual([
			'⚠️ Crewly on Mac was not running from Oct 1, 9:50 AM to Oct 1, 2:39 PM (4 h 49 min) — the computer may have been asleep, or Crewly was stuck. Messages sent in that time were delayed; agents are picking them up now.',
		]);
		clock.t += C.TICK_MS;
		m.tick();
		await new Promise((r) => setImmediate(r));
		expect(sent).toHaveLength(1);
	});

	it('normal ticks raise nothing', async () => {
		const clock = { t: T0 };
		const sent: string[] = [];
		const m = monitor(clock, sent);
		m.start();
		m.stop();
		for (let i = 0; i < 20; i += 1) {
			clock.t += C.TICK_MS;
			m.tick();
		}
		await new Promise((r) => setImmediate(r));
		expect(sent).toEqual([]);
		expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({ lastAliveAt: clock.t, pid: 200 });
	});

	it('a previous process that stopped without a clean shutdown is reported at boot', async () => {
		writeFileSync(storePath, JSON.stringify({ lastAliveAt: T0, pid: 100, startedAt: T0 - 60 * MIN }));
		const clock = { t: T0 + 30 * MIN };
		const sent: string[] = [];
		const m = monitor(clock, sent);
		m.start();
		m.stop();
		await new Promise((r) => setImmediate(r));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toBe(
			'⚠️ Crewly on Mac stopped without shutting down at Oct 1, 9:50 AM and was back at Oct 1, 10:20 AM (30 min offline). Messages sent in that time were delayed; agents are picking them up now.',
		);
	});

	it('a clean shutdown, or a quick restart, is not reported', async () => {
		const sent: string[] = [];
		const first = monitor({ t: T0 }, sent, { pid: 100 });
		first.start();
		first.markCleanShutdown();
		const later = monitor({ t: T0 + 3 * 60 * MIN }, sent);
		later.start();
		later.stop();

		writeFileSync(storePath, JSON.stringify({ lastAliveAt: T0, pid: 100, startedAt: T0 }));
		const quick = monitor({ t: T0 + 2 * MIN }, sent);
		quick.start();
		quick.stop();
		await new Promise((r) => setImmediate(r));
		expect(sent).toEqual([]);
	});

	it('keeps the alert until Slack can deliver it, then gives up after the retry window', async () => {
		writeFileSync(storePath, JSON.stringify({ lastAliveAt: T0, pid: 100, startedAt: T0 }));
		const clock = { t: T0 + 60 * MIN };
		const sent: string[] = [];
		let up = false;
		const m = monitor(clock, sent, { delivered: () => up });
		m.start();
		m.stop();
		await new Promise((r) => setImmediate(r));
		expect(sent).toEqual([]);
		expect(m.pendingGap?.kind).toBe('stopped');
		up = true;
		clock.t += C.TICK_MS;
		m.tick();
		await new Promise((r) => setImmediate(r));
		expect(sent).toHaveLength(1);
		expect(m.pendingGap).toBeNull();

		writeFileSync(storePath, JSON.stringify({ lastAliveAt: T0, pid: 100, startedAt: T0 }));
		up = false;
		const neverClock = { t: T0 + 60 * MIN };
		const never = monitor(neverClock, sent, { delivered: () => up });
		never.start();
		never.stop();
		expect(never.pendingGap).not.toBeNull();
		const end = neverClock.t + C.ALERT_RETRY_MAX_MS + C.TICK_MS;
		while (neverClock.t < end) {
			neverClock.t += C.TICK_MS;
			never.tick();
			await new Promise((r) => setImmediate(r));
		}
		expect(never.pendingGap).toBeNull();
		expect(sent).toHaveLength(1);
	});

	it('formats durations and alert times', () => {
		expect(formatDuration(30 * 1000)).toBe('1 min');
		expect(formatDuration(12 * MIN)).toBe('12 min');
		expect(formatDuration(2 * 60 * MIN)).toBe('2 h');
		expect(livenessAlertText({ kind: 'stalled', from: T0, to: T0 + 15 * MIN }, 'steamfun-ops', 'UTC')).toContain(
			'Crewly on steamfun-ops was not running from Oct 1, 1:50 PM to Oct 1, 2:05 PM (15 min)',
		);
	});
});

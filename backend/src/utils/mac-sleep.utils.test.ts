/**
 * Tests for the macOS last-sleep reader.
 */

import { gapExplainedBySleep, parseSysctlTimeval, readMacLastSleep } from './mac-sleep.utils.js';

// Real output on the owner's Mac, 2026-11-06 (sleep 22:00:47 → wake 22:16:31 ET).
const SYSCTL_OUT =
	'{ sec = 1793934047, usec = 606277 } Thu Nov  5 22:00:47 2026\n' +
	'{ sec = 1793934991, usec = 671102 } Thu Nov  5 22:16:31 2026\n';

describe('mac-sleep.utils', () => {
	it('parses a sysctl timeval line to epoch ms', () => {
		expect(parseSysctlTimeval('{ sec = 1793934047, usec = 606277 } Thu Nov  5 22:00:47 2026')).toBe(1793934047606);
		expect(parseSysctlTimeval('{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970')).toBeNull();
		expect(parseSysctlTimeval('garbage')).toBeNull();
	});

	it('reads the last sleep window on macOS only', () => {
		expect(readMacLastSleep('darwin', () => SYSCTL_OUT)).toEqual({ sleptAt: 1793934047606, wokeAt: 1793934991671 });
		expect(readMacLastSleep('linux', () => SYSCTL_OUT)).toBeNull();
	});

	it('returns null when sysctl fails or the wake is older than the sleep (still asleep)', () => {
		expect(readMacLastSleep('darwin', () => { throw new Error('no sysctl'); })).toBeNull();
		const asleep = '{ sec = 1793934991, usec = 0 } x\n{ sec = 1793934047, usec = 0 } y\n';
		expect(readMacLastSleep('darwin', () => asleep)).toBeNull();
	});

	it('explains the 2026-11-06 false "stuck" gap by the sleep, but not a gap with long awake time', () => {
		const sleep = { sleptAt: 1793934047606, wokeAt: 1793934991671 };
		// Liveness ticks: 03:00:38.489Z → 03:16:33.569Z
		const gap = { from: Date.UTC(2026, 10, 6, 3, 0, 38, 489), to: Date.UTC(2026, 10, 6, 3, 16, 33, 569) };
		expect(gapExplainedBySleep(gap, sleep, 10 * 60 * 1000)).toBe(true);
		expect(gapExplainedBySleep({ from: gap.from - 30 * 60 * 1000, to: gap.to }, sleep, 10 * 60 * 1000)).toBe(false);
		expect(gapExplainedBySleep({ from: gap.to + 1000, to: gap.to + 20 * 60 * 1000 }, sleep, 10 * 60 * 1000)).toBe(false);
		expect(gapExplainedBySleep(gap, null, 10 * 60 * 1000)).toBe(false);
	});
});

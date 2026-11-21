/**
 * Tests for the memory-aware boot helpers (crewly#1353): thresholds, the
 * tight/calm reading, the maintenance gate, the launch hold, the pacer and
 * the one-line owner note. Fake snapshot and clock throughout.
 *
 * @module services/agent/boot-pressure.test
 */

jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

import { BOOT_PRESSURE_CONSTANTS } from '../../constants.js';
import {
	BootLaunchPacer,
	bootLaunchHoldReason,
	bootPressureReason,
	effectiveMinFreeMB,
	bootPressureThresholds,
	joinNames,
	scheduleHeldBackNotice,
	waitForBootQuiet,
	type BootPressureSnapshot,
} from './boot-pressure.js';

const calm: BootPressureSnapshot = { usedPercent: 60, freeMB: 6000, swapUsedPercent: 20, osPressure: false, pressureMode: false };
const incident: BootPressureSnapshot = { usedPercent: 84.4, freeMB: 2552, swapUsedPercent: 95.2, osPressure: true, pressureMode: true };

describe('bootPressureThresholds', () => {
	it('uses the constants block by default and positive integer env overrides', () => {
		expect(bootPressureThresholds({})).toEqual({
			swapUsedPercent: BOOT_PRESSURE_CONSTANTS.SWAP_USED_PERCENT,
			minFreeMB: BOOT_PRESSURE_CONSTANTS.MIN_FREE_MB,
			launchSpacingMs: BOOT_PRESSURE_CONSTANTS.MIN_LAUNCH_SPACING_MS,
		});
		expect(bootPressureThresholds({
			[BOOT_PRESSURE_CONSTANTS.ENV_SWAP_PERCENT]: '70',
			[BOOT_PRESSURE_CONSTANTS.ENV_MIN_FREE_MB]: '2048',
			[BOOT_PRESSURE_CONSTANTS.ENV_LAUNCH_SPACING_MS]: 'nope',
		})).toEqual({ swapUsedPercent: 70, minFreeMB: 2048, launchSpacingMs: BOOT_PRESSURE_CONSTANTS.MIN_LAUNCH_SPACING_MS });
	});
});

describe('bootPressureReason', () => {
	const t = bootPressureThresholds({});

	it('is calm for a calm or unknown reading', () => {
		expect(bootPressureReason(calm, t)).toBeNull();
		expect(bootPressureReason(null, t)).toBeNull();
	});

	it('names every tight signal of the 2026-10-17 reading', () => {
		const reason = bootPressureReason(incident, t) ?? '';
		expect(reason).toContain('pressure mode');
		expect(reason).toContain('OS memory pressure');
		expect(reason).toContain('free 2552MB < 3072MB');
		expect(reason).toContain('osPressure=true');
	});

	it('free memory alone is enough, before pressure mode has engaged', () => {
		expect(bootPressureReason({ ...calm, freeMB: 3000 }, t)).toMatch(/^free 3000MB < 3072MB/);
		expect(bootPressureReason({ ...calm, swapUsedPercent: 79, freeMB: 3072 }, t)).toBeNull();
	});

	it('swap fill alone does not hold a boot back; it counts with little headroom', () => {
		expect(bootPressureReason({ ...calm, swapUsedPercent: 95, freeMB: 6144 }, t)).toBeNull();
		expect(bootPressureReason({ ...calm, swapUsedPercent: 80, freeMB: 5000 }, t)).toMatch(/^swap 80% >= 80% with free 5000MB < 6144MB/);
	});

	it('the OS pressure flag alone is enough', () => {
		expect(bootPressureReason({ ...calm, osPressure: true }, t)).toMatch(/^OS memory pressure/);
	});

	it('the OS warn level is not believed while plenty is available: 48 GB Mac, 10 GB available, swap 97% (2026-11-21)', () => {
		const mini: BootPressureSnapshot = { usedPercent: 78.8, freeMB: 10400, totalMB: 49152, swapUsedPercent: 97.2, osPressure: true, pressureMode: false };
		expect(bootPressureReason(mini, t)).toBeNull();
		// Under the ample mark (8 GB here) the flag counts again.
		expect(bootPressureReason({ ...mini, freeMB: 8000 }, t)).toMatch(/^OS memory pressure/);
		// The critical level counts whatever is free.
		expect(bootPressureReason({ ...mini, osPressureCritical: true }, t)).toMatch(/^OS memory pressure/);
	});

	it('scales the free floor to small machines (8 GB Air)', () => {
		const air: BootPressureSnapshot = { ...calm, totalMB: 8192, freeMB: 2000, swapUsedPercent: 60 };
		expect(effectiveMinFreeMB(air, t)).toBe(1638);
		expect(bootPressureReason(air, t)).toBeNull();
		expect(bootPressureReason({ ...air, freeMB: 1500 }, t)).toMatch(/^free 1500MB < 1638MB/);
		expect(effectiveMinFreeMB({ ...calm, totalMB: 16384 }, t)).toBe(3072);
	});
});

describe('waitForBootQuiet', () => {
	let t: number;
	const now = () => t;
	const sleep = async (ms: number) => { t += ms; };
	beforeEach(() => { t = 0; });

	it('returns at once when the restore is done and memory is calm', async () => {
		expect(await waitForBootQuiet({ restoreDone: () => true, snapshot: () => calm, sleep, now })).toEqual({ waitedMs: 0, reduced: false });
	});

	it('polls until the restore queue drained and memory eased', async () => {
		let drainedAt = 90_000;
		const res = await waitForBootQuiet({
			restoreDone: () => t >= drainedAt,
			snapshot: () => (t < 150_000 ? incident : calm),
			sleep, now,
		});
		expect(res.reduced).toBe(false);
		expect(res.waitedMs).toBe(150_000);
		drainedAt = 0;
	});

	it('gives up after the cap and asks for a reduced pass, saying why it was still waiting', async () => {
		const res = await waitForBootQuiet({ restoreDone: () => false, snapshot: () => incident, sleep, now });
		expect(res.reduced).toBe(true);
		expect(res.waitedMs).toBe(BOOT_PRESSURE_CONSTANTS.MAINTENANCE_WAIT_MAX_MS);
		expect(res.reason).toMatch(/^restore queue still running; pressure mode/);
	});
});

describe('bootLaunchHoldReason', () => {
	let t = 0;
	const now = () => t;
	const base = () => ({ restoreRunning: () => false, pacer: new BootLaunchPacer(now), bootAt: 0, now, thresholds: bootPressureThresholds({}) });

	beforeEach(() => { t = 60_000; });

	it('holds for tight memory within the first hour, then leaves it to pressure mode', () => {
		expect(bootLaunchHoldReason({ ...base(), snapshot: () => incident })).toMatch(/^memory tight: pressure mode/);
		t = BOOT_PRESSURE_CONSTANTS.RETRY_HOLD_MAX_MS + 1;
		expect(bootLaunchHoldReason({ ...base(), snapshot: () => incident })).toBeNull();
	});

	it('holds while the restore queue launches and within the launch spacing of the last launch', () => {
		expect(bootLaunchHoldReason({ ...base(), snapshot: () => calm, restoreRunning: () => true })).toBe('boot restore queue still launching');
		const pacer = new BootLaunchPacer(now);
		pacer.note();
		t += 5_000;
		expect(bootLaunchHoldReason({ ...base(), pacer, snapshot: () => calm })).toBe('a boot launch began 5 s ago');
		t += BOOT_PRESSURE_CONSTANTS.MIN_LAUNCH_SPACING_MS;
		expect(bootLaunchHoldReason({ ...base(), pacer, snapshot: () => calm })).toBeNull();
	});
});

describe('BootLaunchPacer', () => {
	it('reports Infinity before any launch and the elapsed time after one', () => {
		let t = 100;
		const pacer = new BootLaunchPacer(() => t);
		expect(pacer.msSinceLast()).toBe(Infinity);
		pacer.note();
		t = 2_100;
		expect(pacer.msSinceLast()).toBe(2_000);
	});
});

describe('joinNames', () => {
	it('joins like a sentence', () => {
		expect(joinNames([])).toBe('');
		expect(joinNames(['Ella'])).toBe('Ella');
		expect(joinNames(['Ella', 'Pia'])).toBe('Ella and Pia');
		expect(joinNames(['Ella', 'Pia', 'Owen'])).toBe('Ella, Pia and Owen');
	});
});

describe('scheduleHeldBackNotice', () => {
	const fire: Array<() => void> = [];
	const setTimer = (fn: () => void, ms: number) => { expect(ms).toBe(BOOT_PRESSURE_CONSTANTS.OWNER_NOTE_AFTER_MS); fire.push(fn); };
	beforeEach(() => { fire.length = 0; });

	it('sends one plain line naming the agents still down after the delay', async () => {
		const notify = jest.fn(async (_line: string) => true);
		const done = scheduleHeldBackNotice({ stillHeld: async () => ['Ella', 'Pia'], notify, setTimer });
		expect(notify).not.toHaveBeenCalled();
		fire[0]();
		await done;
		expect(notify).toHaveBeenCalledTimes(1);
		const line = notify.mock.calls[0][0];
		expect(line).toBe('Memory is tight on this machine, so Ella and Pia have not been brought back yet; they will start as soon as it eases.');
		expect(line).not.toMatch(/retry|queue|snapshot|swap/i);
	});

	it('says nothing when every held-back agent came back in time', async () => {
		const notify = jest.fn(async () => true);
		const done = scheduleHeldBackNotice({ stillHeld: async () => [], notify, setTimer });
		fire[0]();
		await done;
		expect(notify).not.toHaveBeenCalled();
	});

	it('singular wording for one agent, and a failing notifier never throws', async () => {
		const notify = jest.fn(async (_line: string): Promise<boolean> => { throw new Error('slack down'); });
		const done = scheduleHeldBackNotice({ stillHeld: async () => ['Pia'], notify, setTimer });
		fire[0]();
		await expect(done).resolves.toBeUndefined();
		expect(notify.mock.calls[0][0]).toContain('so Pia has not been brought back yet; it will start');
	});
});

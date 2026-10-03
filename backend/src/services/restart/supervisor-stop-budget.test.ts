/**
 * Tests for the supervisor stop budget.
 */

import { capDrainToSupervisor, parseSystemdTimespanMs, resolveSupervisorStopBudgetMs, systemdUnitFromCgroup } from './supervisor-stop-budget.js';

describe('parseSystemdTimespanMs', () => {
	it.each([
		['2min 30s', 150_000],
		['150s', 150_000],
		['10min 30s', 630_000],
		['500ms', 500],
		['1h', 3_600_000],
		['90', 90_000],
	])('%s → %d ms', (text, ms) => {
		expect(parseSystemdTimespanMs(text)).toBe(ms);
	});

	it('returns null for infinity and junk', () => {
		expect(parseSystemdTimespanMs('infinity')).toBeNull();
		expect(parseSystemdTimespanMs('')).toBeNull();
		expect(parseSystemdTimespanMs('soon')).toBeNull();
		expect(parseSystemdTimespanMs('5 fortnights')).toBeNull();
	});
});

describe('systemdUnitFromCgroup', () => {
	it('finds a user unit, a system unit, and nothing in a login session', () => {
		expect(systemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/crewly.service\n')).toEqual({ unit: 'crewly.service', user: true });
		expect(systemdUnitFromCgroup('0::/system.slice/crewly.service\n')).toEqual({ unit: 'crewly.service', user: false });
		expect(systemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/init.scope\n')).toBeNull();
		expect(systemdUnitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
	});
});

describe('resolveSupervisorStopBudgetMs', () => {
	it('reads TimeoutStopUSec of the unit we run in (steamfun-ops: 150 s)', () => {
		const calls: string[][] = [];
		const ms = resolveSupervisorStopBudgetMs({
			env: { INVOCATION_ID: 'abc' },
			readFile: () => '0::/user.slice/user-0.slice/user@0.service/app.slice/crewly.service\n',
			systemctl: (args) => {
				calls.push(args);
				return '2min 30s\n';
			},
		});
		expect(ms).toBe(150_000);
		expect(calls).toEqual([['--user', 'show', '-p', 'TimeoutStopUSec', '--value', 'crewly.service']]);
	});

	it('is null outside systemd or when systemctl fails', () => {
		expect(resolveSupervisorStopBudgetMs({ env: {} })).toBeNull();
		expect(
			resolveSupervisorStopBudgetMs({
				env: { INVOCATION_ID: 'x' },
				readFile: () => '0::/system.slice/crewly.service',
				systemctl: () => {
					throw new Error('no systemctl');
				},
			}),
		).toBeNull();
	});
});

describe('capDrainToSupervisor', () => {
	it('ends the drain before the supervisor kills, leaving the margin', () => {
		expect(capDrainToSupervisor(600_000, 150_000, 30_000)).toBe(120_000);
		expect(capDrainToSupervisor(120_000, 630_000, 30_000)).toBe(120_000);
		expect(capDrainToSupervisor(600_000, null, 30_000)).toBe(600_000);
		expect(capDrainToSupervisor(600_000, 10_000, 30_000)).toBe(0);
	});
});

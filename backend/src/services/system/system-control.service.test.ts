/**
 * Tests for SystemControlService (owner Upgrade / Restart).
 *
 * Everything that would really restart or upgrade — npm, the graceful
 * shutdown, process.exit, the replacement launcher — is a mock. The progress
 * file lives in a temp CREWLY_HOME.
 *
 * @module services/system/system-control.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	SystemControlService,
	readActionRecord,
	writeActionRecord,
	type BusyAgentInfo,
	type SystemControlDeps,
	type SystemActionRecord,
	type UpgradeInstaller,
} from './system-control.service.js';
import type { SupervisorInfo } from './supervisor-detect.js';
import type { InstallInfo } from './auto-update.utils.js';
import type { InstallAttempt } from './auto-update.service.js';
import { SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');

const NPM_GLOBAL: InstallInfo = {
	kind: 'npm-global',
	packageRoot: '/usr/local/lib/node_modules/crewly',
	prefix: '/usr/local',
	detail: 'npm global install under /usr/local',
};
const DEV_CHECKOUT: InstallInfo = { kind: 'dev-checkout', packageRoot: '/Users/me/crewly', prefix: null, detail: 'dev checkout' };
const UNMANAGED: InstallInfo = { kind: 'unmanaged', packageRoot: '/app', prefix: null, detail: 'not a global npm install (/app)' };

const CLI_START: SupervisorInfo = { kind: 'crewly-start', outer: 'systemd', willRelaunch: 'yes', detail: 'crewly start' };
const NO_SUPERVISOR: SupervisorInfo = { kind: 'none', outer: null, willRelaunch: 'no', detail: 'none' };
const UNKNOWN_SUPERVISOR: SupervisorInfo = { kind: 'unknown', outer: null, willRelaunch: 'unknown', detail: '?' };

interface Harness {
	service: SystemControlService;
	deps: SystemControlDeps;
	installer: jest.Mocked<UpgradeInstaller>;
	clock: { now: number };
	busy: { agents: BusyAgentInfo[] };
	file: string;
}

/**
 * Build a service with mocked deps.
 *
 * @param home - Temp crewly home
 * @param overrides - Dep overrides
 * @param installResult - What the installer returns
 * @returns Harness
 */
function makeHarness(home: string, overrides: Partial<SystemControlDeps> = {}, installResult: InstallAttempt = { ok: true }): Harness {
	const clock = { now: T0 };
	const busy = { agents: [] as BusyAgentInfo[] };
	const installer: jest.Mocked<UpgradeInstaller> = {
		installVersion: jest.fn(async (_version: string) => installResult),
		writeUpgradeMarker: jest.fn(),
		clearUpgradeMarker: jest.fn(),
		isBusy: jest.fn(() => false),
		appendLogLine: jest.fn(),
	};
	const deps: SystemControlDeps = {
		crewlyHome: home,
		install: NPM_GLOBAL,
		currentVersion: '1.20.174',
		pid: 1000,
		bootId: 'boot-1',
		startedAt: new Date(T0).toISOString(),
		getSupervisor: () => CLI_START,
		fetchLatestVersion: jest.fn(async () => '1.20.175'),
		getBusyAgents: () => busy.agents,
		isShutdownInProgress: () => false,
		getInstaller: () => installer,
		requestGracefulRestart: jest.fn(() => true),
		exit: jest.fn(),
		spawnReplacement: jest.fn(),
		logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
		now: () => clock.now,
		sleep: jest.fn(async (ms: number) => {
			clock.now += ms;
		}),
		...overrides,
	};
	return { service: new SystemControlService(deps), deps, installer, clock, busy, file: path.join(home, SYSTEM_CONTROL_CONSTANTS.STATE_FILE) };
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('SystemControlService', () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'system-control-test-'));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	describe('getStatus', () => {
		it('reports an available update on an npm global install', async () => {
			const h = makeHarness(home);
			const status = await h.service.getStatus();
			expect(status).toMatchObject({
				currentVersion: '1.20.174',
				latestVersion: '1.20.175',
				updateAvailable: true,
				installKind: 'npm-global',
				canUpgrade: true,
				upgradeBlockedReason: null,
				canRestart: true,
				relaunch: 'supervisor',
				inProgress: false,
				bootId: 'boot-1',
			});
		});

		it('says up to date when the registry has nothing newer', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => '1.20.174') });
			const status = await h.service.getStatus();
			expect(status.updateAvailable).toBe(false);
			expect(status.canUpgrade).toBe(false);
			expect(status.upgradeBlockedReason).toContain('up to date');
		});

		it('blocks Upgrade on a source checkout with the git message, but still allows Restart', async () => {
			const h = makeHarness(home, { install: DEV_CHECKOUT });
			const status = await h.service.getStatus();
			expect(status.installKind).toBe('dev-checkout');
			expect(status.canUpgrade).toBe(false);
			expect(status.upgradeBlockedReason).toBe(SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT);
			expect(status.canRestart).toBe(true);
		});

		it('maps non-npm installs to "other"', async () => {
			const h = makeHarness(home, { install: UNMANAGED });
			expect((await h.service.getStatus()).installKind).toBe('other');
		});

		it('lists agents mid-turn and asks the registry for a fresh answer on refresh', async () => {
			const h = makeHarness(home);
			h.busy.agents = [{ session: 'crewly-orc', since: 'x', messagePreview: 'hi' }];
			const status = await h.service.getStatus({ refresh: true });
			expect(status.busyAgents).toEqual([{ session: 'crewly-orc', since: 'x', messagePreview: 'hi' }]);
			expect(h.deps.fetchLatestVersion).toHaveBeenCalledWith(SYSTEM_CONTROL_CONSTANTS.REGISTRY_MAX_AGE_MS);
		});

		it('reports the replacement relaunch when nothing supervises the backend', async () => {
			const h = makeHarness(home, { getSupervisor: () => NO_SUPERVISOR });
			expect((await h.service.getStatus()).relaunch).toBe('replacement');
		});

		it('blocks both buttons while an automatic update is running', async () => {
			const h = makeHarness(home);
			h.installer.isBusy.mockReturnValue(true);
			const status = await h.service.getStatus();
			expect(status.canUpgrade).toBe(false);
			expect(status.canRestart).toBe(false);
			expect(status.inProgress).toBe(true);
		});
	});

	describe('upgrade', () => {
		it('refuses a source checkout with 409 and never installs', async () => {
			const h = makeHarness(home, { install: DEV_CHECKOUT });
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(result).toEqual({
				ok: false,
				httpStatus: 409,
				code: SYSTEM_CONTROL_CONSTANTS.CODES.DEV_CHECKOUT,
				error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT,
			});
			expect(h.installer.installVersion).not.toHaveBeenCalled();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
		});

		it('refuses a non-npm install with 409', async () => {
			const h = makeHarness(home, { install: UNMANAGED });
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.NOT_NPM_GLOBAL });
		});

		it('refuses when already up to date', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => '1.20.174') });
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.UP_TO_DATE });
		});

		it('answers 502 when the registry cannot be reached', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => null) });
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: false, httpStatus: 502, code: SYSTEM_CONTROL_CONSTANTS.CODES.REGISTRY_UNREACHABLE });
		});

		it('"now": installs through the AutoUpdate path, writes the marker, then restarts gracefully', async () => {
			const h = makeHarness(home);
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard from 192.168.1.20' });
			expect(result.ok).toBe(true);
			await flush();
			expect(h.installer.installVersion).toHaveBeenCalledWith('1.20.175');
			expect(h.installer.writeUpgradeMarker).toHaveBeenCalledWith('1.20.174', '1.20.175');
			expect(h.deps.requestGracefulRestart).toHaveBeenCalledWith('owner upgrade 1.20.174 -> 1.20.175');
			expect(h.deps.spawnReplacement).not.toHaveBeenCalled();
			const record = readActionRecord(h.file) as SystemActionRecord;
			expect(record).toMatchObject({
				kind: 'upgrade',
				status: 'restarting',
				toVersion: '1.20.175',
				fromVersion: '1.20.174',
				requestedBy: 'dashboard from 192.168.1.20',
				relaunch: 'supervisor',
				pid: 1000,
			});
			expect(h.installer.appendLogLine).toHaveBeenCalledWith(expect.stringContaining('requested by dashboard from 192.168.1.20'));
		});

		it('does not restart onto a failed install and records why', async () => {
			const h = makeHarness(home, {}, { ok: false, outcome: 'install-failed', reason: 'npm exited with 1: EACCES', details: {} });
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
			expect(h.installer.writeUpgradeMarker).not.toHaveBeenCalled();
			const record = readActionRecord(h.file) as SystemActionRecord;
			expect(record.status).toBe('failed');
			expect(record.message).toContain('EACCES');
			expect(h.service.isActionInProgress()).toBe(false);
		});

		it('"idle": waits until no agent is mid-turn before installing', async () => {
			const h = makeHarness(home);
			h.busy.agents = [{ session: 'crewly-orc' }];
			await h.service.requestUpgrade({ when: 'idle', actor: 'dashboard' });
			await flush();
			expect(h.installer.installVersion).not.toHaveBeenCalled();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'waiting-idle', waitingFor: ['crewly-orc'] });

			h.busy.agents = [];
			// The fake sleep resolves at once; let the loop poll again.
			await flush();
			await flush();
			expect(h.installer.installVersion).toHaveBeenCalledWith('1.20.175');
			expect(readActionRecord(h.file)).toMatchObject({ idleWaitEndedBy: 'idle' });
		});

		it('removes the marker when the restart cannot be arranged', async () => {
			const h = makeHarness(home, {
				getSupervisor: () => NO_SUPERVISOR,
				spawnReplacement: jest.fn(() => {
					throw new Error('EAGAIN');
				}),
			});
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.installer.clearUpgradeMarker).toHaveBeenCalled();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'failed' });
		});
	});

	describe('input-guard gate (crewly#1038)', () => {
		const failing = { ok: false, checkedAt: 'x', agents: [{ session: 'orc', runtime: 'claude-code', state: 'unknown' as const, idle: true, verdict: 'fail' as const, reason: 'r' }] };
		const passing = { ok: true, checkedAt: 'x', agents: [] };

		it('checks the installed build before restarting, and restarts when it passes', async () => {
			const checkInputGuard = jest.fn(async () => passing);
			const h = makeHarness(home, { checkInputGuard });
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(checkInputGuard).toHaveBeenCalledWith(NPM_GLOBAL.packageRoot);
			expect(h.deps.requestGracefulRestart).toHaveBeenCalled();
		});

		it('does not restart, keeps the old version, fails the action and tells the owner once', async () => {
			const notifyOwner = jest.fn(async () => undefined);
			const h = makeHarness(home, { checkInputGuard: jest.fn(async () => failing), notifyOwner });
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
			expect(h.installer.writeUpgradeMarker).not.toHaveBeenCalled();
			const record = readActionRecord(h.file);
			expect(record?.status).toBe('failed');
			expect(record?.message).toContain('keeps running 1.20.174');
			expect(notifyOwner).toHaveBeenCalledTimes(1);
			// a second blocked attempt for the same version stays quiet
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(notifyOwner).toHaveBeenCalledTimes(1);
		});

		it('force skips the check and restarts', async () => {
			const checkInputGuard = jest.fn(async () => failing);
			const h = makeHarness(home, { checkInputGuard });
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard', force: true });
			await flush();
			expect(checkInputGuard).not.toHaveBeenCalled();
			expect(h.deps.requestGracefulRestart).toHaveBeenCalled();
		});

		it('a build without the check script does not block', async () => {
			const h = makeHarness(home, { checkInputGuard: jest.fn(async () => ({ ok: true, unavailable: true, checkedAt: 'x', agents: [] })) });
			await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.requestGracefulRestart).toHaveBeenCalled();
		});

		it('runInputGuardCheck defaults to the running package root', async () => {
			const checkInputGuard = jest.fn(async () => passing);
			const h = makeHarness(home, { checkInputGuard });
			await h.service.runInputGuardCheck();
			expect(checkInputGuard).toHaveBeenCalledWith(NPM_GLOBAL.packageRoot);
			await h.service.runInputGuardCheck('/b');
			expect(checkInputGuard).toHaveBeenLastCalledWith('/b');
		});
	});

	describe('restart', () => {
		it('with a supervisor: just runs the graceful restart (exit 120), no replacement', async () => {
			const h = makeHarness(home);
			const result = await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: true, action: { kind: 'restart', status: 'restarting' } });
			await flush();
			expect(h.deps.spawnReplacement).not.toHaveBeenCalled();
			expect(h.deps.requestGracefulRestart).toHaveBeenCalledWith('owner restart');
			expect(h.deps.exit).not.toHaveBeenCalled();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'restarting', relaunch: 'supervisor' });
		});

		it('without a supervisor: starts the replacement launcher before shutting down', async () => {
			const order: string[] = [];
			const h = makeHarness(home, {
				getSupervisor: () => NO_SUPERVISOR,
				spawnReplacement: jest.fn(() => {
					order.push('spawn');
				}),
				requestGracefulRestart: jest.fn(() => {
					order.push('shutdown');
					return true;
				}),
			});
			await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(order).toEqual(['spawn', 'shutdown']);
			expect(h.deps.spawnReplacement).toHaveBeenCalledWith(false);
			expect(readActionRecord(h.file)).toMatchObject({ status: 'restarting', relaunch: 'replacement' });
		});

		it('with an unknown supervisor: starts the launcher in its cautious mode', async () => {
			const h = makeHarness(home, { getSupervisor: () => UNKNOWN_SUPERVISOR });
			await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.spawnReplacement).toHaveBeenCalledWith(true);
		});

		it('does not exit when the replacement cannot be started', async () => {
			const h = makeHarness(home, {
				getSupervisor: () => NO_SUPERVISOR,
				spawnReplacement: jest.fn(() => {
					throw new Error('spawn ENOENT');
				}),
			});
			await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
			expect(h.deps.exit).not.toHaveBeenCalled();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'failed' });
		});

		it('falls back to exit(120) when no graceful handler is registered', async () => {
			const h = makeHarness(home, { requestGracefulRestart: jest.fn(() => false) });
			await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			await flush();
			expect(h.deps.exit).toHaveBeenCalledWith(120);
		});

		it('"idle": goes ahead after the cap even if an agent never finishes', async () => {
			const h = makeHarness(home);
			h.busy.agents = [{ session: 'stuck-agent' }];
			await h.service.requestRestart({ when: 'idle', actor: 'dashboard' });
			// Each poll advances the fake clock by IDLE_POLL_MS; run past the cap.
			const polls = SYSTEM_CONTROL_CONSTANTS.IDLE_WAIT_CAP_MS / SYSTEM_CONTROL_CONSTANTS.IDLE_POLL_MS + 5;
			for (let i = 0; i < polls && !(h.deps.requestGracefulRestart as jest.Mock).mock.calls.length; i++) await flush();
			expect(h.deps.requestGracefulRestart).toHaveBeenCalled();
			expect(h.clock.now - T0).toBeGreaterThanOrEqual(SYSTEM_CONTROL_CONSTANTS.IDLE_WAIT_CAP_MS);
			expect(h.clock.now - T0).toBeLessThan(SYSTEM_CONTROL_CONSTANTS.IDLE_WAIT_CAP_MS + 2 * SYSTEM_CONTROL_CONSTANTS.IDLE_POLL_MS);
			expect(readActionRecord(h.file)).toMatchObject({ idleWaitEndedBy: 'cap', waitingFor: ['stuck-agent'] });
		});

		it('"now" while waiting for idle cuts the wait short (escalation, not a second action)', async () => {
			let releaseSleep: () => void = () => undefined;
			const h = makeHarness(home, {
				sleep: jest.fn((ms: number) => {
					if (ms === SYSTEM_CONTROL_CONSTANTS.IDLE_POLL_MS) {
						return new Promise<void>((r) => {
							releaseSleep = r;
						});
					}
					return Promise.resolve();
				}),
			});
			h.busy.agents = [{ session: 'crewly-orc' }];
			const first = await h.service.requestRestart({ when: 'idle', actor: 'dashboard' });
			await flush();
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
			const second = await h.service.requestRestart({ when: 'now', actor: 'phone (relay)' });
			expect(second).toMatchObject({ ok: true, escalated: true });
			expect(second.ok && first.ok && second.action.id === first.action.id).toBe(true);
			await flush();
			expect(h.deps.requestGracefulRestart).toHaveBeenCalledTimes(1);
			expect(readActionRecord(h.file)).toMatchObject({ idleWaitEndedBy: 'now', when: 'now' });
			releaseSleep();
		});
	});

	describe('double-trigger guard', () => {
		it('refuses a second restart while the first is running', async () => {
			const h = makeHarness(home);
			h.busy.agents = [{ session: 'crewly-orc' }];
			const first = await h.service.requestRestart({ when: 'idle', actor: 'dashboard' });
			expect(first.ok).toBe(true);
			const second = await h.service.requestRestart({ when: 'idle', actor: 'dashboard' });
			expect(second).toMatchObject({ ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.IN_PROGRESS });
		});

		it('refuses an upgrade while a restart is waiting (and vice versa)', async () => {
			const h = makeHarness(home);
			h.busy.agents = [{ session: 'crewly-orc' }];
			await h.service.requestRestart({ when: 'idle', actor: 'dashboard' });
			const upgrade = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(upgrade).toMatchObject({ ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.IN_PROGRESS });
		});

		it('refuses while the process is already shutting down (SIGTERM, auto-update)', async () => {
			const h = makeHarness(home, { isShutdownInProgress: () => true });
			const result = await h.service.requestRestart({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: false, httpStatus: 409, code: SYSTEM_CONTROL_CONSTANTS.CODES.RESTART_IN_PROGRESS });
			expect(h.deps.requestGracefulRestart).not.toHaveBeenCalled();
		});

		it('refuses while an automatic update is installing', async () => {
			const h = makeHarness(home);
			h.installer.isBusy.mockReturnValue(true);
			const result = await h.service.requestUpgrade({ when: 'now', actor: 'dashboard' });
			expect(result).toMatchObject({ ok: false, httpStatus: 409 });
			expect(h.installer.installVersion).not.toHaveBeenCalled();
		});

		it('two requests arriving together start only one action', async () => {
			const h = makeHarness(home);
			const [a, b] = await Promise.all([
				h.service.requestUpgrade({ when: 'now', actor: 'dashboard' }),
				h.service.requestUpgrade({ when: 'now', actor: 'dashboard' }),
			]);
			expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
			await flush();
			expect(h.installer.installVersion).toHaveBeenCalledTimes(1);
		});
	});

	describe('boot settles the previous record', () => {
		/**
		 * A record a previous process left.
		 *
		 * @param patch - Fields
		 * @returns Record
		 */
		function leftover(patch: Partial<SystemActionRecord>): SystemActionRecord {
			return {
				id: 'a1',
				kind: 'restart',
				when: 'now',
				status: 'restarting',
				requestedBy: 'dashboard',
				requestedAt: new Date(T0 - 60_000).toISOString(),
				updatedAt: new Date(T0 - 60_000).toISOString(),
				fromVersion: '1.20.174',
				toVersion: null,
				pid: 999,
				relaunch: 'supervisor',
				message: 'Restarting…',
				...patch,
			};
		}

		it('marks a restart completed with the time it came back', () => {
			const h = makeHarness(home);
			writeActionRecord(h.file, leftover({}));
			h.service.handleBoot();
			const record = readActionRecord(h.file) as SystemActionRecord;
			expect(record.status).toBe('completed');
			expect(record.message).toBe(`Restarted at ${new Date(T0).toISOString()}.`);
			expect(record.completedAt).toBe(new Date(T0).toISOString());
			expect(h.service.isActionInProgress()).toBe(false);
		});

		it('marks an upgrade completed when the new version is running', () => {
			const h = makeHarness(home, { currentVersion: '1.20.175' });
			writeActionRecord(h.file, leftover({ kind: 'upgrade', toVersion: '1.20.175' }));
			h.service.handleBoot();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'completed', resultVersion: '1.20.175' });
		});

		it('marks an upgrade failed when it came back on another version', () => {
			const h = makeHarness(home, { currentVersion: '1.20.174' });
			writeActionRecord(h.file, leftover({ kind: 'upgrade', toVersion: '1.20.175' }));
			h.service.handleBoot();
			const record = readActionRecord(h.file) as SystemActionRecord;
			expect(record.status).toBe('failed');
			expect(record.message).toContain('instead of 1.20.175');
		});

		it('marks an action cut off before it restarted as interrupted', () => {
			const h = makeHarness(home);
			writeActionRecord(h.file, leftover({ kind: 'upgrade', status: 'installing', toVersion: '1.20.175' }));
			h.service.handleBoot();
			expect(readActionRecord(h.file)).toMatchObject({ status: 'interrupted' });
		});

		it('leaves settled records alone', () => {
			const h = makeHarness(home);
			const done = leftover({ status: 'completed', message: 'Restarted at x.' });
			writeActionRecord(h.file, done);
			h.service.handleBoot();
			expect(readActionRecord(h.file)).toEqual(done);
		});
	});
});

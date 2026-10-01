/**
 * Tests for AutoUpdateService — mocked registry, npm, clock and timers; the
 * status/marker files live in a temp CREWLY_HOME.
 *
 * @module services/system/auto-update.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

import { AutoUpdateService, describeModeLine, runNpmInstall, type AutoUpdateDeps, type BusySnapshot } from './auto-update.service.js';
import { AUTO_UPDATE_CONSTANTS } from '../../constants.js';
import type { InstallInfo } from './auto-update.utils.js';

const T0 = Date.parse('2026-09-26T00:00:00Z');

const GLOBAL_INSTALL: InstallInfo = {
	kind: 'npm-global',
	packageRoot: '/usr/local/lib/node_modules/crewly',
	prefix: '/usr/local',
	detail: 'npm global install under /usr/local',
};

interface Harness {
	deps: AutoUpdateDeps;
	service: AutoUpdateService;
	clock: { now: number };
	busy: BusySnapshot[];
	scheduled: Array<{ fn: () => void; ms: number }>;
	installedVersion: { value: string | null };
	notices: Array<{ title: string; message: string }>;
	logLines: string[];
}

/**
 * Build a service with mocked deps.
 *
 * @param home - Temp crewly home
 * @param overrides - Dep overrides
 * @returns Harness
 */
function makeHarness(home: string, overrides: Partial<AutoUpdateDeps> = {}): Harness {
	const clock = { now: T0 };
	const busy: BusySnapshot[] = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	const installedVersion = { value: '1.20.144' as string | null };
	const notices: Array<{ title: string; message: string }> = [];
	const logLines: string[] = [];
	const deps: AutoUpdateDeps = {
		crewlyHome: home,
		install: GLOBAL_INSTALL,
		currentVersion: '1.20.143',
		getSettingEnabled: jest.fn(async () => undefined),
		env: {},
		hasSupervisor: () => true,
		fetchLatestVersion: jest.fn(async () => '1.20.144'),
		isRestartInProgress: () => false,
		getBusy: jest.fn(async () => busy.shift() ?? { midTurn: [], inProgress: [] }),
		runInstall: jest.fn(async () => ({ ok: true, code: 0, outputTail: 'added 1 package' })),
		npmCommand: 'npm',
		getInstallCwd: () => '/home/me/.crewly',
		readInstalledVersion: jest.fn(() => installedVersion.value),
		requestRestart: jest.fn(() => true),
		isNotifyReady: () => true,
		notifyOwner: jest.fn(async (title: string, message: string) => {
			notices.push({ title, message });
		}),
		getDeviceName: async () => 'iriss-air',
		afterInstall: jest.fn(),
		appendLog: (line) => logLines.push(line),
		logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
		now: () => clock.now,
		sleep: jest.fn(async (ms: number) => {
			clock.now += ms;
		}),
		schedule: (fn, ms) => {
			const entry = { fn, ms };
			scheduled.push(entry);
			return entry;
		},
		cancel: (handle) => {
			const i = scheduled.indexOf(handle as { fn: () => void; ms: number });
			if (i >= 0) scheduled.splice(i, 1);
		},
		...overrides,
	};
	return { deps, service: new AutoUpdateService(deps), clock, busy, scheduled, installedVersion, notices, logLines };
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('AutoUpdateService', () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-update-test-'));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		AutoUpdateService.setInstance(null);
	});

	const markerPath = (): string => path.join(home, AUTO_UPDATE_CONSTANTS.MARKER_FILE);

	describe('installVersion (shared with the owner Upgrade button)', () => {
		it('installs into the running prefix from CREWLY_HOME and verifies, without restarting or touching state', async () => {
			const h = makeHarness(home);
			const result = await h.service.installVersion('1.20.144');
			expect(result).toEqual({ ok: true });
			expect(h.deps.runInstall).toHaveBeenCalledWith('npm', ['install', '-g', '--prefix', '/usr/local', 'crewly@1.20.144'], '/home/me/.crewly');
			expect(h.deps.afterInstall).toHaveBeenCalledWith('/usr/local/lib/node_modules/crewly');
			expect(h.deps.requestRestart).not.toHaveBeenCalled();
			expect(h.service.getState().consecutiveFailures).toBe(0);
		});

		it('reports a verify mismatch', async () => {
			const h = makeHarness(home);
			h.installedVersion.value = '1.20.143';
			const result = await h.service.installVersion('1.20.144');
			expect(result).toMatchObject({ ok: false, outcome: 'verify-failed' });
		});

		it('refuses a source checkout', async () => {
			const h = makeHarness(home, { install: { kind: 'dev-checkout', packageRoot: '/src/crewly', prefix: null, detail: 'dev checkout' } });
			const result = await h.service.installVersion('1.20.144');
			expect(result).toMatchObject({ ok: false, outcome: 'skipped' });
			expect(h.deps.runInstall).not.toHaveBeenCalled();
		});

		it('runs one install at a time and reports busy meanwhile', async () => {
			let release: () => void = () => undefined;
			const h = makeHarness(home, {
				runInstall: jest.fn(
					() => new Promise((resolve) => {
						release = () => resolve({ ok: true, code: 0, outputTail: '' });
					}),
				),
			});
			const first = h.service.installVersion('1.20.144');
			await flush();
			expect(h.service.isBusy()).toBe(true);
			await expect(h.service.installVersion('1.20.144')).resolves.toMatchObject({ ok: false, outcome: 'skipped' });
			release();
			await expect(first).resolves.toEqual({ ok: true });
			expect(h.service.isBusy()).toBe(false);
		});

		it('writes and clears the upgrade marker', () => {
			const h = makeHarness(home);
			h.service.writeUpgradeMarker('1.20.143', '1.20.144');
			expect(JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))).toMatchObject({ fromVersion: '1.20.143', toVersion: '1.20.144' });
			h.service.clearUpgradeMarker();
			expect(fs.existsSync(markerPath())).toBe(false);
		});
	});

	describe('scheduling', () => {
		it('schedules the first check ~10 minutes after boot, then every 3 hours', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => '1.20.143') });
			h.service.start();
			expect(h.scheduled).toHaveLength(1);
			expect(h.scheduled[0].ms).toBe(AUTO_UPDATE_CONSTANTS.FIRST_CHECK_DELAY_MS);
			expect(AUTO_UPDATE_CONSTANTS.FIRST_CHECK_DELAY_MS).toBe(10 * 60 * 1000);

			h.scheduled.shift()!.fn();
			await flush();
			expect(h.deps.fetchLatestVersion).toHaveBeenCalledTimes(1);
			expect(h.scheduled).toHaveLength(1);
			expect(h.scheduled[0].ms).toBe(AUTO_UPDATE_CONSTANTS.CHECK_INTERVAL_MS);
			expect(AUTO_UPDATE_CONSTANTS.CHECK_INTERVAL_MS).toBe(3 * 60 * 60 * 1000);
		});

		it('retries sooner while deferred for busy agents', async () => {
			const h = makeHarness(home);
			h.busy.push({ midTurn: ['team-dev'], inProgress: [] });
			h.service.start();
			h.scheduled.shift()!.fn();
			await flush();
			expect(h.scheduled[0].ms).toBe(AUTO_UPDATE_CONSTANTS.BUSY_RETRY_MS);
		});

		it('schedules nothing after handing over to the restart', async () => {
			const h = makeHarness(home);
			h.service.start();
			h.scheduled.shift()!.fn();
			for (let i = 0; i < 5; i++) await flush();
			expect(h.deps.requestRestart).toHaveBeenCalled();
			expect(h.scheduled).toHaveLength(0);
		});

		it('stop() cancels the pending check', () => {
			const h = makeHarness(home);
			h.service.start();
			h.service.stop();
			expect(h.scheduled).toHaveLength(0);
		});
	});

	describe('runCycle', () => {
		it('installs into the running prefix, verifies, writes the marker and restarts', async () => {
			const h = makeHarness(home);
			const result = await h.service.runCycle();
			expect(result).toEqual({ outcome: 'installed-restarting', version: '1.20.144' });
			expect(h.deps.runInstall).toHaveBeenCalledWith('npm', ['install', '-g', '--prefix', '/usr/local', 'crewly@1.20.144'], '/home/me/.crewly');
			expect(h.deps.readInstalledVersion).toHaveBeenCalledWith('/usr/local/lib/node_modules/crewly');
			expect(h.deps.afterInstall).toHaveBeenCalledWith('/usr/local/lib/node_modules/crewly');
			expect(h.deps.requestRestart).toHaveBeenCalledWith('auto-update 1.20.143 -> 1.20.144');
			const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
			expect(marker).toMatchObject({ fromVersion: '1.20.143', toVersion: '1.20.144' });
			expect(h.service.getState().lastResult?.outcome).toBe('installed-restarting');
		});

		it('targets the user prefix when the running copy lives there', async () => {
			const h = makeHarness(home, {
				install: {
					kind: 'npm-global',
					packageRoot: '/home/me/.crewly/npm-global/lib/node_modules/crewly',
					prefix: '/home/me/.crewly/npm-global',
					detail: 'user prefix',
				},
			});
			await h.service.runCycle();
			expect(h.deps.runInstall).toHaveBeenCalledWith('npm', ['install', '-g', '--prefix', '/home/me/.crewly/npm-global', 'crewly@1.20.144'], '/home/me/.crewly');
		});

		it('does nothing when already on the latest version', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => '1.20.143') });
			expect((await h.service.runCycle()).outcome).toBe('up-to-date');
			expect(h.deps.runInstall).not.toHaveBeenCalled();
			const state = h.service.getState();
			expect(state.latestVersion).toBe('1.20.143');
			expect(state.lastCheckAt).toBe(new Date(T0).toISOString());
		});

		it('reports a failed registry check without installing', async () => {
			const h = makeHarness(home, { fetchLatestVersion: jest.fn(async () => null) });
			expect((await h.service.runCycle()).outcome).toBe('check-failed');
			expect(h.deps.runInstall).not.toHaveBeenCalled();
		});

		describe('quiet window', () => {
			it('defers while a turn is in flight', async () => {
				const h = makeHarness(home);
				h.busy.push({ midTurn: ['crewly-orc'], inProgress: [] });
				const result = await h.service.runCycle();
				expect(result.outcome).toBe('deferred-busy');
				expect(result.detail).toContain('crewly-orc');
				expect(h.deps.runInstall).not.toHaveBeenCalled();
			});

			it('defers while an agent is in_progress', async () => {
				const h = makeHarness(home);
				h.busy.push({ midTurn: [], inProgress: ['team-dev'] });
				expect((await h.service.runCycle()).outcome).toBe('deferred-busy');
				expect(h.deps.runInstall).not.toHaveBeenCalled();
			});

			it('checks twice, ~60 s apart, and defers when the second probe is busy', async () => {
				const h = makeHarness(home);
				h.busy.push({ midTurn: [], inProgress: [] }, { midTurn: ['team-dev'], inProgress: [] });
				expect((await h.service.runCycle()).outcome).toBe('deferred-busy');
				expect(h.deps.sleep).toHaveBeenCalledWith(AUTO_UPDATE_CONSTANTS.QUIET_CONFIRM_MS);
				expect(h.deps.getBusy).toHaveBeenCalledTimes(2);
				expect(h.deps.runInstall).not.toHaveBeenCalled();
			});

			it('stops waiting for a stale in_progress flag after the max deferral, but never for a turn in flight', async () => {
				const h = makeHarness(home);
				h.busy.push({ midTurn: [], inProgress: ['team-dev'] });
				expect((await h.service.runCycle()).outcome).toBe('deferred-busy');
				h.clock.now += AUTO_UPDATE_CONSTANTS.MAX_BUSY_DEFER_MS + 1;
				h.busy.push({ midTurn: ['team-dev'], inProgress: ['team-dev'] });
				expect((await h.service.runCycle()).outcome).toBe('deferred-busy');
				h.busy.push({ midTurn: [], inProgress: ['team-dev'] }, { midTurn: [], inProgress: ['team-dev'] });
				expect((await h.service.runCycle()).outcome).toBe('installed-restarting');
			});
		});

		describe('skips', () => {
			it('never installs over a dev checkout', async () => {
				const h = makeHarness(home, {
					install: { kind: 'dev-checkout', packageRoot: '/Users/me/crewly', prefix: null, detail: 'dev checkout' },
				});
				const result = await h.service.runCycle();
				expect(result).toEqual({ outcome: 'skipped', detail: 'dev-checkout' });
				expect(h.deps.fetchLatestVersion).not.toHaveBeenCalled();
				expect(h.deps.runInstall).not.toHaveBeenCalled();
				expect(h.logLines.some((l) => l.includes('dev checkout — auto-update off'))).toBe(true);
			});

			it('logs the dev-checkout line once, not every cycle', async () => {
				const h = makeHarness(home, {
					install: { kind: 'dev-checkout', packageRoot: '/Users/me/crewly', prefix: null, detail: 'dev checkout' },
				});
				await h.service.runCycle();
				await h.service.runCycle();
				expect(h.logLines.filter((l) => l.includes('dev checkout')).length).toBe(1);
			});

			it('skips an unmanaged install (e.g. Docker /app)', async () => {
				const h = makeHarness(home, { install: { kind: 'unmanaged', packageRoot: '/app', prefix: null, detail: 'not global' } });
				expect((await h.service.runCycle()).detail).toBe('unmanaged');
			});

			it('respects settings.general.autoUpdate = false', async () => {
				const h = makeHarness(home, { getSettingEnabled: jest.fn(async () => false) });
				expect(await h.service.runCycle()).toEqual({ outcome: 'skipped', detail: 'disabled-setting' });
				expect(h.deps.runInstall).not.toHaveBeenCalled();
			});

			it('respects CREWLY_AUTO_UPDATE=0 even when the setting is on', async () => {
				const h = makeHarness(home, { getSettingEnabled: jest.fn(async () => true), env: { CREWLY_AUTO_UPDATE: '0' } });
				expect(await h.service.runCycle()).toEqual({ outcome: 'skipped', detail: 'disabled-env' });
			});

			it('CREWLY_AUTO_UPDATE=1 overrides a disabled setting', async () => {
				const h = makeHarness(home, { getSettingEnabled: jest.fn(async () => false), env: { CREWLY_AUTO_UPDATE: '1' } });
				expect((await h.service.runCycle()).outcome).toBe('installed-restarting');
			});

			it('skips when nothing would bring the backend back', async () => {
				const h = makeHarness(home, { hasSupervisor: () => false });
				expect(await h.service.runCycle()).toEqual({ outcome: 'skipped', detail: 'no-supervisor' });
			});

			it('skips when a restart is already in progress', async () => {
				const h = makeHarness(home, { isRestartInProgress: () => true });
				expect((await h.service.runCycle()).detail).toBe('restart already in progress');
				expect(h.deps.fetchLatestVersion).not.toHaveBeenCalled();
			});

			it('re-checks for a restart after the quiet window', async () => {
				let calls = 0;
				const h = makeHarness(home, { isRestartInProgress: () => calls++ > 0 });
				expect((await h.service.runCycle()).detail).toBe('restart already in progress');
				expect(h.deps.runInstall).not.toHaveBeenCalled();
			});
		});

		describe('failures', () => {
			it('verify mismatch: no restart, backoff, marker not left behind', async () => {
				const h = makeHarness(home);
				h.installedVersion.value = '1.20.143';
				const result = await h.service.runCycle();
				expect(result.outcome).toBe('verify-failed');
				expect(h.deps.requestRestart).not.toHaveBeenCalled();
				expect(fs.existsSync(markerPath())).toBe(false);
				const state = h.service.getState();
				expect(state.consecutiveFailures).toBe(1);
				// The failure is recorded after the 60 s quiet-window confirmation.
				expect(state.backoffUntil).toBe(new Date(T0 + AUTO_UPDATE_CONSTANTS.QUIET_CONFIRM_MS + AUTO_UPDATE_CONSTANTS.FAILURE_BACKOFF_MS).toISOString());
			});

			it('install error: no restart and backoff; during backoff nothing is attempted', async () => {
				const h = makeHarness(home, { runInstall: jest.fn(async () => ({ ok: false, code: 243, outputTail: 'npm ERR! code EACCES\n' })) });
				const result = await h.service.runCycle();
				expect(result.outcome).toBe('install-failed');
				expect(result.detail).toContain('EACCES');
				expect(h.deps.requestRestart).not.toHaveBeenCalled();

				h.clock.now += 60 * 60 * 1000;
				expect((await h.service.runCycle()).outcome).toBe('backoff');
				expect(h.deps.runInstall).toHaveBeenCalledTimes(1);

				h.clock.now += AUTO_UPDATE_CONSTANTS.FAILURE_BACKOFF_MS;
				expect((await h.service.runCycle()).outcome).toBe('install-failed');
			});

			it('runs npm from the install cwd, not the package root it replaces', async () => {
				const h = makeHarness(home);
				await h.service.runCycle();
				expect(h.deps.runInstall).toHaveBeenCalledWith('npm', ['install', '-g', '--prefix', '/usr/local', 'crewly@1.20.144'], '/home/me/.crewly');
				expect(h.logLines.join('\n')).toContain('(cwd /home/me/.crewly)');
			});

			it('a Node crash names the error, not the bare "Node.js vX" trailer, and logs the sanitised tail', async () => {
				const crash = [
					'/usr/lib/node_modules/npm/lib/cli/validate-engines.js:31',
					'    throw err',
					'Error: ENOENT: no such file or directory, uv_cwd',
					'    at process.wrappedCwd (node:internal/bootstrap/switches/does_own_process_state:142:28)',
					"  syscall: 'uv_cwd'",
					'//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123',
					'Node.js v22.23.2',
				].join('\n');
				const h = makeHarness(home, { runInstall: jest.fn(async () => ({ ok: false, code: 7, outputTail: crash })) });
				const result = await h.service.runCycle();
				expect(result.detail).toBe('npm exited with 7: Error: ENOENT: no such file or directory, uv_cwd (… Node.js v22.23.2)');
				const warn = (h.deps.logger.warn as jest.Mock).mock.calls.find((c) => c[0] === 'Auto-update failed; backing off');
				expect(warn?.[1]).toMatchObject({ exitCode: 7, cwd: '/home/me/.crewly', command: 'npm install -g --prefix /usr/local crewly@1.20.144' });
				expect(warn?.[1].outputTail).toContain('uv_cwd');
				expect(warn?.[1].outputTail).toContain('[redacted]');
				expect(warn?.[1].outputTail).not.toContain('npm_abcdefghijklmnopqrstuvwxyz0123');
			});

			it('a thrown install is a failure, not a crash', async () => {
				const h = makeHarness(home, { runInstall: jest.fn(async () => { throw new Error('spawn npm ENOENT'); }) });
				expect((await h.service.runCycle()).detail).toContain('ENOENT');
			});

			it('DMs the owner once after repeated failures for the same version', async () => {
				const h = makeHarness(home, { runInstall: jest.fn(async () => ({ ok: false, code: 1, outputTail: 'boom' })) });
				await h.service.runCycle();
				await flush();
				expect(h.notices).toHaveLength(0);

				h.clock.now += AUTO_UPDATE_CONSTANTS.FAILURE_BACKOFF_MS + 1;
				await h.service.runCycle();
				await flush();
				expect(h.notices).toHaveLength(1);
				expect(h.notices[0].message).toContain('1.20.144');
				expect(h.notices[0].message).toContain('iriss-air');
				expect(h.notices[0].message).toContain('boom');

				h.clock.now += AUTO_UPDATE_CONSTANTS.FAILURE_BACKOFF_MS + 1;
				await h.service.runCycle();
				await flush();
				expect(h.notices).toHaveLength(1);
			});

			it('restart unavailable: failure recorded and marker removed', async () => {
				const h = makeHarness(home, { requestRestart: jest.fn(() => false) });
				expect((await h.service.runCycle()).outcome).toBe('restart-unavailable');
				expect(fs.existsSync(markerPath())).toBe(false);
			});
		});
	});

	describe('boot marker', () => {
		const writeMarker = (from: string, to: string, at: number): void => {
			fs.writeFileSync(markerPath(), JSON.stringify({ fromVersion: from, toVersion: to, at: new Date(at).toISOString() }));
		};

		it('notifies the owner once the new version is up, and clears failures', async () => {
			fs.writeFileSync(
				path.join(home, AUTO_UPDATE_CONSTANTS.STATE_FILE),
				JSON.stringify({ consecutiveFailures: 1, backoffUntil: new Date(T0 + 1000).toISOString() }),
			);
			writeMarker('1.20.143', '1.20.144', T0 - 60_000);
			const h = makeHarness(home, { currentVersion: '1.20.144' });
			h.service.start();
			await flush();
			expect(h.notices).toEqual([{ title: 'Crewly auto-upgraded to 1.20.144 (machine: iriss-air)', message: 'Previous version: 1.20.143' }]);
			expect(h.service.isUpgradeBoot()).toBe(true);
			expect(fs.existsSync(markerPath())).toBe(false);
			const state = h.service.getState();
			expect(state.lastResult?.outcome).toBe('upgraded');
			expect(state.consecutiveFailures).toBe(0);
			expect(state.backoffUntil).toBeNull();
		});

		it('waits for the owner channel to connect before sending', async () => {
			writeMarker('1.20.143', '1.20.144', T0);
			let ready = false;
			const h = makeHarness(home, { currentVersion: '1.20.144', isNotifyReady: () => ready });
			(h.deps.sleep as jest.Mock).mockImplementation(async (ms: number) => {
				h.clock.now += ms;
				ready = true;
			});
			h.service.start();
			await flush();
			expect(h.deps.sleep).toHaveBeenCalledWith(AUTO_UPDATE_CONSTANTS.NOTIFY_POLL_MS);
			expect(h.notices).toHaveLength(1);
		});

		it('gives up quietly when the channel never connects', async () => {
			writeMarker('1.20.143', '1.20.144', T0);
			const h = makeHarness(home, { currentVersion: '1.20.144', isNotifyReady: () => false });
			h.service.start();
			for (let i = 0; i < 10; i++) await flush();
			expect(h.notices).toHaveLength(0);
			expect(h.logLines.some((l) => l.includes('notice not sent'))).toBe(true);
		});

		it('records a failure when the restart came back on another version', async () => {
			writeMarker('1.20.143', '1.20.144', T0);
			const h = makeHarness(home, { currentVersion: '1.20.143' });
			h.service.start();
			await flush();
			expect(h.notices).toHaveLength(0);
			expect(h.service.isUpgradeBoot()).toBe(false);
			expect(h.service.getState().lastResult?.outcome).toBe('verify-failed');
		});

		it('ignores a stale marker', async () => {
			writeMarker('1.20.100', '1.20.101', T0 - AUTO_UPDATE_CONSTANTS.MARKER_MAX_AGE_MS - 1);
			const h = makeHarness(home, { currentVersion: '1.20.101' });
			h.service.start();
			await flush();
			expect(h.notices).toHaveLength(0);
			expect(fs.existsSync(markerPath())).toBe(false);
		});

		it('an ordinary boot is not an upgrade boot', () => {
			const h = makeHarness(home);
			h.service.start();
			expect(h.service.isUpgradeBoot()).toBe(false);
		});
	});

	describe('instance registry', () => {
		it('stores and clears the process-wide instance', () => {
			const h = makeHarness(home);
			AutoUpdateService.setInstance(h.service);
			expect(AutoUpdateService.getInstance()).toBe(h.service);
			AutoUpdateService.setInstance(null);
			expect(AutoUpdateService.getInstance()).toBeNull();
		});
	});

	describe('describeModeLine', () => {
		it('names each mode', () => {
			expect(describeModeLine('dev-checkout', { ...GLOBAL_INSTALL, kind: 'dev-checkout', packageRoot: '/repo' })).toBe(
				'dev checkout — auto-update off (/repo)',
			);
			expect(describeModeLine('disabled-env', GLOBAL_INSTALL)).toContain('CREWLY_AUTO_UPDATE');
			expect(describeModeLine('disabled-setting', GLOBAL_INSTALL)).toContain('Settings');
			expect(describeModeLine('no-supervisor', GLOBAL_INSTALL)).toContain('crewly start');
			expect(describeModeLine('unmanaged', GLOBAL_INSTALL)).toContain('not an npm global install');
			expect(describeModeLine('enabled', GLOBAL_INSTALL)).toContain('auto-update on');
		});
	});

	describe('runNpmInstall', () => {
		it('reports success, output and exit code of the command', async () => {
			const lines: string[] = [];
			const ok = await runNpmInstall(process.execPath, ['-e', 'console.log("added 1 package")'], (l) => lines.push(l));
			expect(ok.ok).toBe(true);
			expect(ok.code).toBe(0);
			expect(lines.join('\n')).toContain('added 1 package');

			const bad = await runNpmInstall(process.execPath, ['-e', 'console.error("npm ERR! x"); process.exit(3)'], () => undefined);
			expect(bad).toMatchObject({ ok: false, code: 3 });
			expect(bad.outputTail).toContain('npm ERR!');
		});

		it('runs in the given cwd even when the inherited one was deleted', async () => {
			const base = fs.mkdtempSync(path.join(os.tmpdir(), 'au-cwd-'));
			const good = path.join(base, 'home');
			fs.mkdirSync(good);
			const r = await runNpmInstall(process.execPath, ['-e', 'console.log(process.cwd())'], () => undefined, 5000, good);
			expect(r.ok).toBe(true);
			expect(fs.realpathSync(r.outputTail.trim())).toBe(fs.realpathSync(good));
			fs.rmSync(base, { recursive: true, force: true });
		});

		it('redacts credentials in the logged output', async () => {
			const lines: string[] = [];
			await runNpmInstall(process.execPath, ['-e', 'console.log("GET https://bob:hunter2@registry.example.com/x")'], (l) => lines.push(l));
			expect(lines.join('\n')).toContain('https://[redacted]@registry.example.com/x');
			expect(lines.join('\n')).not.toContain('hunter2');
		});

		it('reports a missing executable as a failure', async () => {
			const r = await runNpmInstall('/nonexistent/npm-binary', [], () => undefined);
			expect(r.ok).toBe(false);
		});

		it('kills the command after the timeout', async () => {
			const lines: string[] = [];
			const r = await runNpmInstall(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], (l) => lines.push(l), 200);
			expect(r.ok).toBe(false);
			expect(lines.join('\n')).toContain('timed out');
		});
	});
});

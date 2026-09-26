/**
 * Tests for `crewly update-status`.
 */

jest.mock('chalk', () => {
	const id = (s: string) => s;
	return { __esModule: true, default: { bold: id, red: id, green: id, yellow: id } };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	collectUpdateStatus,
	describeMode,
	formatUpdateStatus,
	readAutoUpdateSetting,
	resolveLiveMode,
	updateStatusCommand,
	type UpdateStatusDeps,
} from './update-status.js';

describe('update-status', () => {
	let home: string;
	let globalRoot: string;

	beforeEach(() => {
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-status-')));
		fs.mkdirSync(path.join(home, '.crewly', 'logs'), { recursive: true });
		globalRoot = path.join(home, 'prefix', 'lib', 'node_modules', 'crewly');
		fs.mkdirSync(globalRoot, { recursive: true });
		fs.writeFileSync(path.join(globalRoot, 'package.json'), JSON.stringify({ name: 'crewly', version: '1.20.143' }));
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		jest.restoreAllMocks();
	});

	const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

	const deps = (over: Partial<UpdateStatusDeps> = {}): UpdateStatusDeps => ({
		env: {},
		homeDir: home,
		fetchImpl: jest.fn().mockResolvedValue(reply({ version: '1.20.143', latestVersion: '1.20.144', updateAvailable: true })),
		getInstalledVersion: () => '1.20.143',
		getPackageRoot: () => globalRoot,
		...over,
	});

	it('reports versions, mode, last check and last result from the status file', async () => {
		fs.writeFileSync(
			path.join(home, '.crewly', 'auto-update-state.json'),
			JSON.stringify({
				mode: 'enabled',
				lastCheckAt: '2026-09-26T03:00:00.000Z',
				latestVersion: '1.20.144',
				lastResult: { outcome: 'deferred-busy', at: '2026-09-26T03:00:00.000Z', version: '1.20.144', message: 'turns in flight: crewly-orc' },
				consecutiveFailures: 0,
			}),
		);
		const input = await collectUpdateStatus(deps());
		const text = formatUpdateStatus(input).join('\n');
		expect(text).toContain('Installed version: 1.20.143');
		expect(text).toContain('Running version:   1.20.143');
		expect(text).toContain('Latest on npm:     1.20.144');
		expect(text).toContain('Auto-update:       on');
		expect(text).toContain('Last check:        2026-09-26T03:00:00.000Z');
		expect(text).toContain('deferred-busy 1.20.144');
		expect(text).toContain('crewly-orc');
		expect(text).toContain(path.join(home, '.crewly', 'logs', 'auto-update.log'));
	});

	it('works when the backend is down and nothing has run yet', async () => {
		const input = await collectUpdateStatus(deps({ fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }));
		const text = formatUpdateStatus(input).join('\n');
		expect(text).toContain('backend not running');
		expect(text).toContain('Latest on npm:     unknown');
		expect(text).toContain('Last check:        never');
		expect(text).toContain('Last result:       none');
	});

	it('shows failures and the back-off', () => {
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const lines = formatUpdateStatus({
			installedVersion: '1.20.143',
			runningVersion: '1.20.143',
			healthLatest: null,
			state: {
				currentVersion: '1.20.143',
				latestVersion: '1.20.144',
				lastCheckAt: null,
				mode: 'disabled-env',
				lastResult: { outcome: 'install-failed', at: 'x', version: '1.20.144', message: 'EACCES' },
				consecutiveFailures: 2,
				backoffUntil: future,
				failureNotifiedVersion: '1.20.144',
			},
			mode: 'enabled',
			logFile: '/l',
		});
		expect(lines.join('\n')).toContain('Failures in a row: 2');
		expect(lines.join('\n')).toContain(`Next attempt after: ${future}`);
		expect(lines.join('\n')).toContain('backend last saw');
	});

	it('resolves the live mode: dev checkout, env, setting', () => {
		const repo = path.join(home, 'repo');
		fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
		expect(resolveLiveMode(repo, true, {})).toBe('dev-checkout');
		expect(resolveLiveMode(path.join(home, 'app'), true, {})).toBe('unmanaged');
		expect(resolveLiveMode(globalRoot, true, { CREWLY_AUTO_UPDATE: '0' })).toBe('disabled-env');
		expect(resolveLiveMode(globalRoot, false, {})).toBe('disabled-setting');
		expect(resolveLiveMode(globalRoot, undefined, {})).toBe('enabled');
	});

	it('reads the setting from settings.json', () => {
		expect(readAutoUpdateSetting(home)).toBeUndefined();
		fs.writeFileSync(path.join(home, '.crewly', 'settings.json'), JSON.stringify({ general: { autoUpdate: false } }));
		expect(readAutoUpdateSetting(home)).toBe(false);
	});

	it('describes every mode', () => {
		for (const mode of ['enabled', 'enabled-env', 'disabled-setting', 'disabled-env', 'dev-checkout', 'unmanaged', 'no-supervisor']) {
			expect(describeMode(mode)).toMatch(/^(on|off)/);
		}
		expect(describeMode('weird')).toBe('weird');
	});

	it('prints the report and exits 0', async () => {
		expect(await updateStatusCommand(deps())).toBe(0);
		expect(console.log).toHaveBeenCalledWith('Crewly update status');
	});
});

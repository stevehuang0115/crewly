/**
 * Tests for supervisor detection (who relaunches the backend after it exits).
 *
 * @module services/system/supervisor-detect.test
 */

import { detectSupervisor, type SupervisorProbe } from './supervisor-detect.js';

/**
 * Build a probe.
 *
 * @param overrides - Fields to change
 * @returns Probe
 */
function probe(overrides: Partial<SupervisorProbe> = {}): SupervisorProbe {
	return {
		env: {},
		platform: 'linux',
		parentCommandLine: () => '/bin/zsh',
		grandparentCommandLine: () => null,
		...overrides,
	};
}

describe('detectSupervisor', () => {
	it('recognises crewly start from the env it sets on the backend', () => {
		const info = detectSupervisor(probe({ env: { CREWLY_RESTART_SUPERVISOR: 'cli-start' } }));
		expect(info).toMatchObject({ kind: 'crewly-start', willRelaunch: 'yes', outer: null });
	});

	it('recognises an older crewly start parent from its command line', () => {
		const info = detectSupervisor(probe({ parentCommandLine: () => 'node /usr/local/lib/node_modules/crewly/dist/cli/cli/src/index.js start' }));
		expect(info).toMatchObject({ kind: 'crewly-start', willRelaunch: 'yes' });
	});

	it('reports systemd above crewly start (steamfun-ops crewly.service)', () => {
		const info = detectSupervisor(probe({ env: { CREWLY_RESTART_SUPERVISOR: 'cli-start', INVOCATION_ID: 'abc' } }));
		expect(info).toMatchObject({ kind: 'crewly-start', outer: 'systemd', willRelaunch: 'yes' });
		expect(info.detail).toContain('systemd');
	});

	it('reports the macOS login item above crewly start (owner Mac)', () => {
		const info = detectSupervisor(
			probe({
				platform: 'darwin',
				env: { CREWLY_RESTART_SUPERVISOR: 'cli-start', XPC_SERVICE_NAME: '0' },
				grandparentCommandLine: () => '/bin/bash /Users/me/.crewly/crewly-start.command',
			}),
		);
		expect(info).toMatchObject({ kind: 'crewly-start', outer: 'login-wrapper', willRelaunch: 'yes' });
	});

	it('reports launchd above crewly start', () => {
		const info = detectSupervisor(
			probe({ platform: 'darwin', env: { CREWLY_RESTART_SUPERVISOR: 'cli-start', XPC_SERVICE_NAME: 'com.crewly.agent' } }),
		);
		expect(info).toMatchObject({ kind: 'crewly-start', outer: 'launchd' });
	});

	it('does not treat a Terminal shell as launchd', () => {
		const info = detectSupervisor(
			probe({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'application.com.apple.Terminal.123' }, parentCommandLine: () => '-zsh' }),
		);
		expect(info).toMatchObject({ kind: 'none', willRelaunch: 'no' });
	});

	it('says "unknown" for a backend directly under systemd (depends on Restart=)', () => {
		const info = detectSupervisor(probe({ env: { INVOCATION_ID: 'abc' }, parentCommandLine: () => '/lib/systemd/systemd --user' }));
		expect(info).toMatchObject({ kind: 'systemd', willRelaunch: 'unknown' });
	});

	it('says "unknown" for a launchd job without crewly start', () => {
		const info = detectSupervisor(probe({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'com.example.crewly' }, parentCommandLine: () => '/sbin/launchd' }));
		expect(info).toMatchObject({ kind: 'launchd', willRelaunch: 'unknown' });
	});

	it('says "unknown" when the parent cannot be read', () => {
		const info = detectSupervisor(probe({ parentCommandLine: () => null }));
		expect(info).toMatchObject({ kind: 'unknown', willRelaunch: 'unknown' });
	});

	it('trusts PM2 to restart the app', () => {
		const info = detectSupervisor(probe({ env: { pm_id: '0' }, parentCommandLine: () => 'PM2 v5.3.0: God Daemon' }));
		expect(info).toMatchObject({ kind: 'pm2', willRelaunch: 'yes' });
	});

	it('says "none" for a bare node run from a shell', () => {
		const info = detectSupervisor(probe({ parentCommandLine: () => '-zsh' }));
		expect(info).toMatchObject({ kind: 'none', willRelaunch: 'no' });
	});
});

/**
 * Tests for the auto-update helpers.
 *
 * @module services/system/auto-update.utils.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	composeFailureNotice,
	composeUpgradedNotice,
	consumePendingMarker,
	describeInstallFailure,
	derivePrefixFromPackageRoot,
	detectInstall,
	emptyAutoUpdateState,
	findCrewlyPackageRoot,
	hasRestartSupervisor,
	installOutputTail,
	isGitWorkingTree,
	isNewerVersion,
	isSwitchOn,
	npmInstallArgs,
	readAutoUpdateState,
	readInstalledVersion,
	readProcessCommandLine,
	realOrResolved,
	sanitizeNpmOutput,
	resolveAutoUpdateSwitch,
	resolveInstallCwd,
	resolveNpmCommand,
	resolveRunningPackageRoot,
	writeAutoUpdateState,
	writePendingMarker,
} from './auto-update.utils.js';

describe('auto-update.utils', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = realOrResolved(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-update-utils-')));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/**
	 * Create a fake crewly package at `dir`.
	 *
	 * @param dir - Package root
	 * @param version - Version
	 */
	const makePackage = (dir: string, version = '1.20.143'): void => {
		fs.mkdirSync(path.join(dir, 'dist', 'backend', 'backend', 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'crewly', version }));
		fs.writeFileSync(path.join(dir, 'dist', 'backend', 'backend', 'src', 'index.js'), '');
	};

	describe('derivePrefixFromPackageRoot', () => {
		it('finds the default global prefix', () => {
			expect(derivePrefixFromPackageRoot('/usr/local/lib/node_modules/crewly', 'linux')).toBe('/usr/local');
			expect(derivePrefixFromPackageRoot('/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/crewly', 'darwin')).toBe(
				'/Users/me/.nvm/versions/node/v22.14.0',
			);
		});

		it('finds the user prefix (<crewlyHome>/npm-global)', () => {
			expect(derivePrefixFromPackageRoot('/home/me/.crewly/npm-global/lib/node_modules/crewly', 'linux')).toBe(
				'/home/me/.crewly/npm-global',
			);
		});

		it('handles the Windows layout (no lib/)', () => {
			expect(derivePrefixFromPackageRoot('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\crewly', 'win32')).toBe(
				'C:\\Users\\me\\AppData\\Roaming\\npm',
			);
		});

		it('rejects local dependencies, npx caches and non-npm paths', () => {
			expect(derivePrefixFromPackageRoot('/home/me/proj/node_modules/crewly', 'linux')).toBeNull();
			expect(derivePrefixFromPackageRoot('/app', 'linux')).toBeNull();
			expect(derivePrefixFromPackageRoot('/usr/local/lib/node_modules/other', 'linux')).toBeNull();
		});
	});

	describe('detectInstall', () => {
		it('classifies a git working tree as a dev checkout', () => {
			const repo = path.join(tmp, 'crewly');
			makePackage(repo);
			fs.mkdirSync(path.join(repo, '.git'));
			expect(detectInstall(repo, 'darwin')).toMatchObject({ kind: 'dev-checkout', prefix: null });
		});

		it('classifies a git worktree (.git file) as a dev checkout', () => {
			const repo = path.join(tmp, 'crewly-wt');
			makePackage(repo);
			fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /somewhere');
			expect(isGitWorkingTree(repo)).toBe(true);
			expect(detectInstall(repo, 'darwin').kind).toBe('dev-checkout');
		});

		it('classifies a global install with its prefix', () => {
			const root = path.join(tmp, 'prefix', 'lib', 'node_modules', 'crewly');
			makePackage(root);
			expect(detectInstall(root, 'linux')).toMatchObject({ kind: 'npm-global', prefix: path.join(tmp, 'prefix') });
		});

		it('classifies anything else as unmanaged', () => {
			const root = path.join(tmp, 'app');
			makePackage(root);
			expect(detectInstall(root, 'linux').kind).toBe('unmanaged');
			expect(detectInstall(null).kind).toBe('unmanaged');
		});
	});

	describe('package root and versions', () => {
		it('resolves the package root from the entry script, through symlinks', () => {
			const root = path.join(tmp, 'prefix', 'lib', 'node_modules', 'crewly');
			makePackage(root);
			const link = path.join(tmp, 'link');
			fs.symlinkSync(root, link);
			const entry = path.join(link, 'dist', 'backend', 'backend', 'src', 'index.js');
			expect(resolveRunningPackageRoot(entry)).toBe(root);
			expect(findCrewlyPackageRoot(path.join(root, 'dist'))).toBe(root);
		});

		it('falls back to the cwd, and returns null when nothing matches', () => {
			const root = path.join(tmp, 'pkg');
			makePackage(root);
			expect(resolveRunningPackageRoot('', root)).toBe(root);
			expect(resolveRunningPackageRoot('', os.tmpdir())).toBeNull();
		});

		it('reads the installed version fresh from disk', () => {
			const root = path.join(tmp, 'pkg');
			makePackage(root, '1.20.143');
			expect(readInstalledVersion(root)).toBe('1.20.143');
			fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'crewly', version: '1.20.144' }));
			expect(readInstalledVersion(root)).toBe('1.20.144');
			expect(readInstalledVersion(path.join(tmp, 'missing'))).toBeNull();
		});

		it('compares versions numerically', () => {
			expect(isNewerVersion('1.20.144', '1.20.143')).toBe(true);
			expect(isNewerVersion('1.20.100', '1.20.99')).toBe(true);
			expect(isNewerVersion('1.20.143', '1.20.143')).toBe(false);
			expect(isNewerVersion('1.19.999', '1.20.0')).toBe(false);
			expect(isNewerVersion('2.0.0-beta.1', '1.99.0')).toBe(true);
		});
	});

	describe('npm command', () => {
		it('builds exact-version install args for the prefix', () => {
			expect(npmInstallArgs('/usr/local', '1.20.144')).toEqual(['install', '-g', '--prefix', '/usr/local', 'crewly@1.20.144']);
		});

		it('prefers the npm next to the running node', () => {
			const bin = path.join(tmp, 'bin');
			fs.mkdirSync(bin);
			fs.writeFileSync(path.join(bin, 'npm'), '');
			expect(resolveNpmCommand(path.join(bin, 'node'), 'linux')).toBe(path.join(bin, 'npm'));
			expect(resolveNpmCommand(path.join(tmp, 'nothing', 'node'), 'linux')).toBe('npm');
			expect(resolveNpmCommand(path.join(tmp, 'nothing', 'node.exe'), 'win32')).toBe('npm.cmd');
		});
	});

	describe('on/off switch', () => {
		it('defaults to on', () => {
			expect(resolveAutoUpdateSwitch(undefined, {})).toBe('enabled');
			expect(resolveAutoUpdateSwitch(true, {})).toBe('enabled');
		});

		it('honours the setting', () => {
			expect(resolveAutoUpdateSwitch(false, {})).toBe('disabled-setting');
		});

		it('lets the env override win either way', () => {
			for (const v of ['0', 'false', 'OFF', 'no']) {
				expect(resolveAutoUpdateSwitch(true, { CREWLY_AUTO_UPDATE: v })).toBe('disabled-env');
			}
			expect(resolveAutoUpdateSwitch(false, { CREWLY_AUTO_UPDATE: '1' })).toBe('enabled-env');
			expect(resolveAutoUpdateSwitch(false, { CREWLY_AUTO_UPDATE: 'maybe' })).toBe('disabled-setting');
		});

		it('isSwitchOn', () => {
			expect(isSwitchOn('enabled')).toBe(true);
			expect(isSwitchOn('enabled-env')).toBe(true);
			expect(isSwitchOn('disabled-env')).toBe(false);
			expect(isSwitchOn('disabled-setting')).toBe(false);
		});
	});

	describe('hasRestartSupervisor', () => {
		it('trusts the env marker set by crewly start', () => {
			expect(hasRestartSupervisor({ CREWLY_RESTART_SUPERVISOR: 'cli-start' }, () => null)).toBe(true);
		});

		it('recognises an older crewly start parent by its command line', () => {
			expect(hasRestartSupervisor({}, () => 'node dist/cli/cli/src/index.js start')).toBe(true);
			expect(hasRestartSupervisor({}, () => '/usr/bin/node /usr/local/bin/crewly start --no-browser')).toBe(true);
		});

		it('rejects anything else', () => {
			expect(hasRestartSupervisor({}, () => 'pm2: agentmux-server')).toBe(false);
			expect(hasRestartSupervisor({}, () => 'bash')).toBe(false);
			expect(hasRestartSupervisor({}, () => null)).toBe(false);
		});

		it('reads a real process command line', () => {
			if (process.platform === 'win32') return;
			expect(readProcessCommandLine(process.pid)).toContain('node');
			expect(readProcessCommandLine(0)).toBeNull();
		});
	});

	describe('state and marker files', () => {
		it('round-trips the state and tolerates a missing/malformed file', () => {
			const file = path.join(tmp, 'home', 'auto-update-state.json');
			expect(readAutoUpdateState(file)).toEqual(emptyAutoUpdateState());
			writeAutoUpdateState(file, { ...emptyAutoUpdateState(), latestVersion: '1.20.144', consecutiveFailures: 2 });
			expect(readAutoUpdateState(file)).toMatchObject({ latestVersion: '1.20.144', consecutiveFailures: 2 });
			fs.writeFileSync(file, '{nope');
			expect(readAutoUpdateState(file)).toEqual(emptyAutoUpdateState());
		});

		it('consumes the marker exactly once, removing malformed ones too', () => {
			const file = path.join(tmp, 'home', 'auto-update-pending.json');
			expect(consumePendingMarker(file)).toBeNull();
			writePendingMarker(file, { fromVersion: '1.20.143', toVersion: '1.20.144', at: '2026-09-26T00:00:00.000Z' });
			expect(consumePendingMarker(file)).toEqual({ fromVersion: '1.20.143', toVersion: '1.20.144', at: '2026-09-26T00:00:00.000Z' });
			expect(consumePendingMarker(file)).toBeNull();
			fs.writeFileSync(file, '{"fromVersion":1}');
			expect(consumePendingMarker(file)).toBeNull();
			expect(fs.existsSync(file)).toBe(false);
		});
	});

	describe('notices', () => {
		it('composes the upgrade notice', () => {
			expect(composeUpgradedNotice('1.20.144', 'iriss-air')).toBe('Crewly auto-upgraded to 1.20.144 (machine: iriss-air)');
		});

		it('composes the failure notice with the reason', () => {
			const text = composeFailureNotice('1.20.144', 'steamfun-ops', 2, 'EACCES');
			expect(text).toContain('1.20.144');
			expect(text).toContain('steamfun-ops');
			expect(text).toContain('2');
			expect(text).toContain('EACCES');
		});
	});
});

describe('resolveInstallCwd', () => {
	it('picks the first existing absolute directory', () => {
		const exists = new Set(['/root', '/tmp']);
		expect(resolveInstallCwd(['/root/.crewly', undefined, 'relative', '/root', '/tmp'], (d) => exists.has(d))).toBe('/root');
	});

	it('falls back to the filesystem root when nothing exists', () => {
		expect(resolveInstallCwd(['/nope'], () => false)).toBe(path.parse(process.execPath).root);
	});

	it('uses the real filesystem by default', () => {
		expect(resolveInstallCwd([path.join(os.tmpdir(), 'definitely-missing-dir-xyz'), os.tmpdir()])).toBe(os.tmpdir());
	});
});

describe('sanitizeNpmOutput', () => {
	it('redacts npmrc tokens, auth headers, URL credentials and bare tokens', () => {
		const raw = [
			'//registry.npmjs.org/:_authToken=abc123secret',
			'authorization: Bearer eyJhbGciOi.xyz',
			'fetch https://user:pw@registry.example.com/crewly',
			'token npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
			'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
			'npm error code ENOENT',
		].join('\n');
		const out = sanitizeNpmOutput(raw);
		for (const secret of ['abc123secret', 'eyJhbGciOi.xyz', 'user:pw', 'npm_ABCDEFGHIJ', 'ghp_ABCDEFGHIJ']) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain('npm error code ENOENT');
		expect(out).toContain('https://[redacted]@registry.example.com/crewly');
	});
});

describe('describeInstallFailure', () => {
	it('quotes the error line and the trailer of a Node crash', () => {
		const tail = 'x.js:31\n    throw err\nError: ENOENT: no such file or directory, uv_cwd\n    at foo\n}\n\nNode.js v22.23.2\n';
		expect(describeInstallFailure(7, tail)).toBe('npm exited with 7: Error: ENOENT: no such file or directory, uv_cwd (… Node.js v22.23.2)');
	});

	it('quotes npm error lines ahead of the log-file pointer', () => {
		const tail = 'npm error code EACCES\nnpm error syscall mkdir\nnpm error A complete log of this run can be found in: /root/.npm/_logs/x.log';
		expect(describeInstallFailure(243, tail)).toBe('npm exited with 243: npm error code EACCES (… npm error A complete log of this run can be found in: /root/.npm/_logs/x.log)');
	});

	it('uses the last line alone when it is the error, and handles no output / a signal', () => {
		expect(describeInstallFailure(1, 'npm ERR! code E404')).toBe('npm exited with 1: npm ERR! code E404');
		expect(describeInstallFailure(1, 'boom')).toBe('npm exited with 1: boom');
		expect(describeInstallFailure(null, '')).toBe('npm exited with a signal');
	});

	it('clips very long lines', () => {
		const r = describeInstallFailure(1, `Error: ${'x'.repeat(1000)}`);
		expect(r.length).toBeLessThan(300);
		expect(r.endsWith('…')).toBe(true);
	});
});

describe('installOutputTail', () => {
	it('keeps the last N non-empty sanitised lines', () => {
		const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n\n_authToken=secretvalue\n';
		const tail = installOutputTail(text, 5).split('\n');
		expect(tail).toEqual(['line 56', 'line 57', 'line 58', 'line 59', '_authToken=[redacted]']);
	});
});

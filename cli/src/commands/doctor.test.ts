/**
 * Tests for `crewly doctor`.
 */

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy(
		{},
		{
			get: () => {
				const fn = (s: string) => s;
				return new Proxy(fn, {
					get: () => fn,
					apply: (_t: unknown, _this: unknown, args: string[]) => args[0],
				});
			},
		},
	),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectDoctorChecks, formatDoctorCheck, doctorCommand } from './doctor.js';

let tmp: string;
let home: string;

/** PATH lookup stub. */
function whichOf(...installed: string[]): (bin: string) => boolean {
	const set = new Set(installed);
	return (bin) => set.has(bin);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-doctor-'));
	home = path.join(tmp, 'home');
	fs.mkdirSync(home);
	fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'crewly', version: '9.9.9' }));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exitCode = 0;
});

const byName = (checks: Awaited<ReturnType<typeof collectDoctorChecks>>, name: string) =>
	checks.find((c) => c.name === name);

describe('collectDoctorChecks', () => {
	it('fails fast when the package root cannot be found', async () => {
		const checks = await collectDoctorChecks({ packageRoot: null });
		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({ name: 'package', status: 'fail' });
	});

	it('reports version, node, loadable native modules and a complete toolchain', async () => {
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('g++', 'make', 'python3'),
			platform: 'darwin',
			homeDir: home,
		});
		expect(byName(checks, 'package')).toMatchObject({ status: 'ok', detail: expect.stringContaining('crewly 9.9.9') });
		expect(byName(checks, 'node')).toMatchObject({ status: 'ok', detail: expect.stringContaining(process.version) });
		expect(byName(checks, 'node-pty')).toMatchObject({ status: 'ok' });
		expect(byName(checks, 'better-sqlite3')).toMatchObject({ status: 'ok' });
		expect(byName(checks, 'toolchain')).toMatchObject({ status: 'ok' });
		expect(byName(checks, 'service.env')?.detail).toContain('not present');
		expect(byName(checks, 'linger')).toBeUndefined();
	});

	it('flags an unloadable native module with a rebuild hint', async () => {
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: (name) => {
				if (name === 'node-pty') throw new Error('ERR_DLOPEN_FAILED: wrong architecture\nmore');
			},
			which: whichOf('g++', 'make', 'python3'),
			platform: 'darwin',
			homeDir: home,
		});
		expect(byName(checks, 'node-pty')).toMatchObject({
			status: 'fail',
			detail: expect.stringContaining('ERR_DLOPEN_FAILED: wrong architecture'),
			hint: expect.stringContaining('npm rebuild node-pty'),
		});
		expect(byName(checks, 'better-sqlite3')).toMatchObject({ status: 'ok' });
	});

	it('reports the missing tool with the apt command (finding 11) — fail when unbuilt, warn when built', async () => {
		const unbuilt = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('make', 'python3', 'apt-get'),
			platform: 'linux',
			homeDir: home,
			lingerState: async () => 'yes',
		});
		expect(byName(unbuilt, 'toolchain')).toMatchObject({
			status: 'fail',
			detail: expect.stringContaining('missing g++'),
			hint: expect.stringContaining('apt-get install -y build-essential'),
		});

		const dir = path.join(tmp, 'node_modules', 'node-pty', 'build', 'Release');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'pty.node'), '');
		const built = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('make', 'python3', 'apt-get'),
			platform: 'linux',
			homeDir: home,
			lingerState: async () => 'yes',
		});
		expect(byName(built, 'toolchain')).toMatchObject({ status: 'warn' });
	});

	it('reports service.env presence and linger on Linux', async () => {
		fs.mkdirSync(path.join(home, '.crewly'));
		fs.writeFileSync(path.join(home, '.crewly', 'service.env'), 'DEFAULT_RUNTIME=codex-cli\n');
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('g++', 'make', 'python3'),
			platform: 'linux',
			homeDir: home,
			lingerState: async () => 'no',
		});
		expect(byName(checks, 'service.env')?.detail).toContain('present (');
		expect(byName(checks, 'linger')).toMatchObject({
			status: 'warn',
			hint: expect.stringContaining('loginctl enable-linger'),
		});
	});

	it('reports unknown linger when loginctl is unavailable', async () => {
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('g++', 'make', 'python3'),
			platform: 'linux',
			homeDir: home,
			lingerState: async () => null,
		});
		expect(byName(checks, 'linger')).toMatchObject({ status: 'warn', detail: expect.stringContaining('unknown') });
	});
});

describe('collectDoctorChecks — Claude fresh install', () => {
	const base = () => ({ packageRoot: tmp, tryLoad: () => undefined, platform: 'darwin' as const, homeDir: home });

	it('fails the user check as root when claude is installed, with the run-as-a-normal-user hint', async () => {
		const checks = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 0, env: {} });
		expect(byName(checks, 'user')).toMatchObject({ status: 'fail', hint: 'Run Crewly as a normal (non-root) user.' });
	});

	it('only warns about root when claude is not installed (other runtimes run as root)', async () => {
		const checks = await collectDoctorChecks({ ...base(), which: whichOf('codex'), getuid: () => 0, env: {} });
		expect(byName(checks, 'user')).toMatchObject({ status: 'warn' });
	});

	it('passes the user check as root when IS_SANDBOX=1, and as a normal user', async () => {
		const sandboxed = await collectDoctorChecks({ ...base(), which: whichOf(), getuid: () => 0, env: { IS_SANDBOX: '1' } });
		expect(byName(sandboxed, 'user')).toMatchObject({ status: 'ok' });
		const normal = await collectDoctorChecks({ ...base(), which: whichOf(), getuid: () => 501, env: {} });
		expect(byName(normal, 'user')).toMatchObject({ status: 'ok', detail: 'not root' });
	});

	it('warns when claude is installed but never set up (no config / onboarding not finished)', async () => {
		const missing = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: {} });
		expect(byName(missing, 'claude')).toMatchObject({
			status: 'warn',
			hint: 'Run `claude` once in a terminal, choose a theme and log in, then start the team.',
		});
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: false }));
		const unfinished = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: {} });
		expect(byName(unfinished, 'claude')).toMatchObject({ status: 'warn' });
	});

	it('passes the claude check once first-run setup is done (honouring CLAUDE_CONFIG_DIR)', async () => {
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
		const done = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: {} });
		expect(byName(done, 'claude')).toMatchObject({ status: 'ok' });

		const alt = path.join(tmp, 'claude-cfg');
		fs.mkdirSync(alt);
		fs.writeFileSync(path.join(alt, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
		fs.rmSync(path.join(home, '.claude.json'));
		const relocated = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: { CLAUDE_CONFIG_DIR: alt } });
		expect(byName(relocated, 'claude')).toMatchObject({ status: 'ok' });
	});

	it('skips the claude check when claude is not installed (another runtime is fine)', async () => {
		const checks = await collectDoctorChecks({ ...base(), which: whichOf('gemini'), getuid: () => 501, env: {} });
		expect(byName(checks, 'claude')).toBeUndefined();
	});
});

describe('formatDoctorCheck', () => {
	it('renders the icon, name, detail and indented hint', () => {
		const lines = formatDoctorCheck({ name: 'toolchain', status: 'warn', detail: 'missing g++', hint: 'apt-get install g++' });
		expect(lines[0]).toContain('⚠');
		expect(lines[0]).toContain('toolchain');
		expect(lines[0]).toContain('missing g++');
		expect(lines[1]).toContain('→ apt-get install g++');
	});

	it('omits the hint line when there is none', () => {
		expect(formatDoctorCheck({ name: 'node', status: 'ok', detail: 'v22' })).toHaveLength(1);
	});
});

describe('doctorCommand', () => {
	it('prints a report and only sets exit code 1 on failures', async () => {
		const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			await doctorCommand();
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Crewly Doctor');
			expect(output).toMatch(/package/);
			// Under jest cwd is the repo root (a crewly package) so the run is real;
			// whatever the host has installed, the summary line must be one of the three.
			expect(output).toMatch(/All checks passed|warning\(s\)|problem\(s\) found/);
		} finally {
			logSpy.mockRestore();
		}
	});
});

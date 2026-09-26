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
import { collectDoctorChecks, formatDoctorCheck, doctorCommand, marketplaceCheck, nativeModuleHint, runtimeChecks, type UrlProbe } from './doctor.js';
import type { RuntimeAuthStatus } from '../utils/runtime-auth.js';

let tmp: string;
let home: string;

/** Marketplace probe stubs: never touch the network in tests. */
const okProbe: UrlProbe = async () => ({ ok: true, detail: 'HTTP 200' });
const downProbe: UrlProbe = async () => ({ ok: false, detail: 'ENOTFOUND' });

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
			probeUrl: okProbe,
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
			probeUrl: okProbe,
		});
		expect(byName(checks, 'node-pty')).toMatchObject({
			status: 'fail',
			detail: expect.stringContaining('ERR_DLOPEN_FAILED: wrong architecture'),
			hint: expect.stringContaining('npm rebuild node-pty'),
		});
		expect(byName(checks, 'better-sqlite3')).toMatchObject({ status: 'ok' });
	});

	it('reports the missing tool with the apt command (finding 11) — fail when unbuilt, warn when built', async () => {
		// node-pty installed without a prebuild for this host, not compiled yet.
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty'), { recursive: true });
		const unbuilt = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('make', 'python3', 'apt-get'),
			platform: 'linux',
			homeDir: home,
			probeUrl: okProbe,
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
			probeUrl: okProbe,
			lingerState: async () => 'yes',
		});
		expect(byName(built, 'toolchain')).toMatchObject({ status: 'warn' });
	});

	it('toolchain is ok without build tools when node-pty uses its prebuild (#778)', async () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`), { recursive: true });
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			which: whichOf('apt-get'),
			platform: 'darwin',
			homeDir: home,
			probeUrl: okProbe,
		});
		const toolchain = byName(checks, 'toolchain');
		if (process.platform === 'linux' && process.report?.getReport && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime) {
			// musl host: the glibc prebuild does not count.
			expect(toolchain).toMatchObject({ status: 'fail' });
		} else {
			expect(toolchain).toMatchObject({ status: 'ok', detail: expect.stringContaining('not needed') });
		}
	});

	it('fails node-pty when its spawn-helper is not executable, with a chmod hint', async () => {
		const checks = await collectDoctorChecks({
			packageRoot: tmp,
			tryLoad: () => undefined,
			findBrokenSpawnHelper: () => '/pkg/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
			which: whichOf('g++', 'make', 'python3'),
			platform: 'darwin',
			homeDir: home,
			probeUrl: okProbe,
		});
		expect(byName(checks, 'node-pty')).toMatchObject({
			status: 'fail',
			detail: expect.stringContaining('posix_spawnp'),
			hint: 'chmod +x /pkg/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
		});
		expect(byName(checks, 'better-sqlite3')).toMatchObject({ status: 'ok' });
	});

	it('node-pty hint skips "reinstall" when the host cannot run the prebuild (musl)', () => {
		const hint = nativeModuleHint('node-pty', '/pkg', 'musl libc (e.g. Alpine) — the prebuilds target glibc');
		expect(hint).toContain('musl');
		expect(hint).toContain('cd /pkg && npm rebuild node-pty --build-from-source');
		expect(hint).not.toContain('Reinstall');
		expect(nativeModuleHint('node-pty', '/pkg')).toContain('Reinstall');
		expect(nativeModuleHint('better-sqlite3', '/pkg')).toBe('Rebuild with: cd /pkg && npm rebuild better-sqlite3');
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
			probeUrl: okProbe,
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
			probeUrl: okProbe,
			lingerState: async () => null,
		});
		expect(byName(checks, 'linger')).toMatchObject({ status: 'warn', detail: expect.stringContaining('unknown') });
	});
});

describe('collectDoctorChecks — Claude fresh install', () => {
	const base = () => ({ packageRoot: tmp, tryLoad: () => undefined, platform: 'darwin' as const, homeDir: home, probeUrl: okProbe });

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

	it('passes the claude check once first-run setup is done and logged in (honouring CLAUDE_CONFIG_DIR)', async () => {
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'x' } }));
		const done = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: {} });
		expect(byName(done, 'claude')).toMatchObject({ status: 'ok' });

		const alt = path.join(tmp, 'claude-cfg');
		fs.mkdirSync(alt);
		fs.writeFileSync(path.join(alt, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'x' } }));
		fs.rmSync(path.join(home, '.claude.json'));
		const relocated = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: { CLAUDE_CONFIG_DIR: alt } });
		expect(byName(relocated, 'claude')).toMatchObject({ status: 'ok' });
	});

	it('warns when claude was set up but is logged out (#779)', async () => {
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
		const checks = await collectDoctorChecks({ ...base(), which: whichOf('claude'), getuid: () => 501, env: {} });
		expect(byName(checks, 'claude')).toMatchObject({ status: 'warn', detail: expect.stringContaining('no login found'), hint: expect.stringContaining('/login') });
		expect(byName(checks, 'runtime')).toMatchObject({ status: 'fail' });
	});

	it('skips the claude check when claude is not installed (another runtime is fine)', async () => {
		const checks = await collectDoctorChecks({ ...base(), which: whichOf('gemini'), getuid: () => 501, env: {} });
		expect(byName(checks, 'claude')).toBeUndefined();
	});
});

describe('collectDoctorChecks — what agents need (#779)', () => {
	/** Everything present: jq, curl, a logged-in Codex, marketplace up. */
	const healthy = () => {
		fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
		fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'x' } }));
		return {
			packageRoot: tmp,
			tryLoad: () => undefined,
			platform: 'darwin' as const,
			homeDir: home,
			getuid: () => 501,
			env: {},
			which: whichOf('g++', 'make', 'python3', 'jq', 'curl', 'codex'),
			probeUrl: okProbe,
		};
	};

	it('passes jq, curl, runtime and marketplace on a working machine', async () => {
		const checks = await collectDoctorChecks(healthy());
		expect(byName(checks, 'jq')).toMatchObject({ status: 'ok' });
		expect(byName(checks, 'curl')).toMatchObject({ status: 'ok' });
		expect(byName(checks, 'codex')).toMatchObject({ status: 'ok', detail: 'logged in (ChatGPT account)' });
		expect(byName(checks, 'runtime')).toMatchObject({ status: 'ok', detail: 'ready: Codex CLI' });
		expect(byName(checks, 'marketplace')).toMatchObject({ status: 'ok' });
		expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
	});

	it('fails a missing jq or curl with the install command for the platform', async () => {
		const mac = await collectDoctorChecks({ ...healthy(), which: whichOf('g++', 'make', 'python3', 'codex') });
		expect(byName(mac, 'jq')).toMatchObject({ status: 'fail', hint: 'brew install jq' });
		expect(byName(mac, 'curl')).toMatchObject({ status: 'fail', hint: 'brew install curl' });

		const linux = await collectDoctorChecks({ ...healthy(), platform: 'linux', lingerState: async () => 'yes', which: whichOf('g++', 'make', 'python3', 'codex', 'curl') });
		expect(byName(linux, 'jq')).toMatchObject({ status: 'fail', hint: expect.stringContaining('sudo apt-get install -y jq') });
	});

	it('fails when no runtime is installed, naming the install and login commands', async () => {
		const checks = await collectDoctorChecks({ ...healthy(), which: whichOf('g++', 'make', 'python3', 'jq', 'curl') });
		const runtime = byName(checks, 'runtime');
		expect(runtime).toMatchObject({ status: 'fail', detail: expect.stringContaining('no AI runtime is installed and logged in') });
		expect(runtime?.hint).toContain('npm install -g @anthropic-ai/claude-code');
		expect(runtime?.hint).toContain('codex login');
		// Gemini CLI is retired for new users: Antigravity CLI is offered instead.
		expect(runtime?.hint).toContain('https://antigravity.google/cli/install.sh');
		expect(runtime?.hint).not.toContain('npm install -g @google/gemini-cli');
	});

	it('fails when the only installed runtime is not logged in, and lists its login command first', async () => {
		fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
		const checks = await collectDoctorChecks({
			packageRoot: tmp, tryLoad: () => undefined, platform: 'darwin', homeDir: home, getuid: () => 501, env: {},
			which: whichOf('g++', 'make', 'python3', 'jq', 'curl', 'codex'), probeUrl: okProbe,
		});
		expect(byName(checks, 'codex')).toMatchObject({ status: 'warn', hint: expect.stringContaining('codex login') });
		const runtime = byName(checks, 'runtime');
		expect(runtime?.status).toBe('fail');
		expect(runtime?.hint?.startsWith('Set up one: Codex CLI: codex login')).toBe(true);
	});

	it('counts Gemini as ready with a configured API key (Crewly pre-selects API-key auth, #781)', async () => {
		fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
		const checks = await collectDoctorChecks({
			packageRoot: tmp, tryLoad: () => undefined, platform: 'darwin', homeDir: home, getuid: () => 501,
			env: { GEMINI_API_KEY: 'k' }, which: whichOf('g++', 'make', 'python3', 'jq', 'curl', 'gemini'), probeUrl: okProbe,
		});
		expect(byName(checks, 'gemini')).toMatchObject({ status: 'ok', detail: expect.stringContaining('$GEMINI_API_KEY') });
		expect(byName(checks, 'runtime')).toMatchObject({ status: 'ok' });
		// The key value itself is never shown
		expect(JSON.stringify(checks)).not.toContain('"k"');
	});

	it('fails an unreachable marketplace with a curl command to test it', async () => {
		const checks = await collectDoctorChecks({ ...healthy(), probeUrl: downProbe });
		expect(byName(checks, 'marketplace')).toMatchObject({
			status: 'fail',
			detail: expect.stringContaining('ENOTFOUND'),
			hint: expect.stringContaining('curl -fsSI https://'),
		});
	});
});

describe('runtimeChecks', () => {
	const rt = (over: Partial<RuntimeAuthStatus>): RuntimeAuthStatus => ({
		id: 'codex', displayName: 'Codex CLI', installed: true, loggedIn: true, detail: 'logged in', fix: 'codex login', ...over,
	});

	it('only lists installed runtimes individually', () => {
		const checks = runtimeChecks([rt({ id: 'claude', displayName: 'Claude Code', installed: false, loggedIn: false }), rt({})]);
		expect(checks.map((c) => c.name)).toEqual(['codex', 'runtime']);
	});

	it('warns about a logged-out runtime even when another one is ready', () => {
		const checks = runtimeChecks([rt({ id: 'gemini', displayName: 'Gemini CLI', loggedIn: false, detail: 'no key', fix: 'set GEMINI_API_KEY' }), rt({})]);
		expect(checks.find((c) => c.name === 'gemini')).toMatchObject({ status: 'warn', hint: 'set GEMINI_API_KEY' });
		expect(checks.find((c) => c.name === 'runtime')).toMatchObject({ status: 'ok', detail: 'ready: Codex CLI' });
	});
});

describe('runtimeChecks — no runtime ready', () => {
	const rt = (over: Partial<RuntimeAuthStatus>): RuntimeAuthStatus => ({
		id: 'codex', displayName: 'Codex CLI', installed: false, loggedIn: false, detail: 'not installed', fix: 'npm install -g @openai/codex', ...over,
	});

	it('suggests Antigravity CLI but not the retired Gemini CLI to a new user', () => {
		const checks = runtimeChecks([
			rt({}),
			rt({ id: 'antigravity', displayName: 'Antigravity CLI', fix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash, then crewly login antigravity' }),
			rt({ id: 'gemini', displayName: 'Gemini CLI', fix: 'npm install -g @google/gemini-cli', retired: true }),
		]);
		const runtime = checks.find((c) => c.name === 'runtime');
		expect(runtime?.status).toBe('fail');
		expect(runtime?.hint).toContain('Antigravity CLI');
		expect(runtime?.hint).not.toContain('gemini-cli');
	});

	it('still points an existing Gemini CLI user at finishing its login', () => {
		const checks = runtimeChecks([rt({ id: 'gemini', displayName: 'Gemini CLI', installed: true, detail: 'no key', fix: 'set GEMINI_API_KEY', retired: true })]);
		expect(checks.find((c) => c.name === 'runtime')?.hint).toContain('Gemini CLI: set GEMINI_API_KEY');
	});
});

describe('marketplaceCheck', () => {
	it('warns when only one source is reachable', async () => {
		const probe: UrlProbe = async (url) => (url.includes('githubusercontent') ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'HTTP 503' });
		const check = await marketplaceCheck(probe);
		expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining('crewlyai.com registry') });
		expect(check.detail).toContain('HTTP 503');
	});

	it('probes the same registry URLs the installer fetches', async () => {
		const seen: string[] = [];
		await marketplaceCheck(async (url) => {
			seen.push(url);
			return { ok: true, detail: 'HTTP 200' };
		});
		expect(seen).toEqual([
			'https://raw.githubusercontent.com/stevehuang0115/crewly/main/config/skills/registry.json',
			'https://crewlyai.com/api/registry/skills',
		]);
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
	it('never claims a pass and exits 1 when a required item is missing (#779)', async () => {
		const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			await doctorCommand({
				packageRoot: tmp, tryLoad: () => undefined, platform: 'darwin', homeDir: home, getuid: () => 501, env: {},
				which: whichOf('g++', 'make', 'python3', 'curl', 'codex'), probeUrl: okProbe,
			});
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).not.toContain('All checks passed');
			expect(output).toMatch(/problem\(s\) found/);
			expect(output).toContain('brew install jq');
			expect(process.exitCode).toBe(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it('prints a report and only sets exit code 1 on failures', async () => {
		const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		try {
			await doctorCommand({ probeUrl: okProbe });
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

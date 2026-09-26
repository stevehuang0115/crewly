/**
 * Tests for harness status detection (all exec calls mocked).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessCredentialsStore } from './harness-credentials.store.js';
import { getHarnessDefinition } from './harness-registry.js';
import { HarnessStatusService, compareVersions, parseCodexLoginSource, parseVersion } from './harness-status.service.js';
import type { CommandResult, RunCommand } from './harness.types.js';

/** Scripted command runner: key = `cmd args…`. */
function fakeRun(table: Record<string, Partial<CommandResult>>): jest.MockedFunction<RunCommand> {
	return jest.fn(async (command: string, args: readonly string[]) => {
		const key = `${path.basename(command)} ${args.join(' ')}`.trim();
		const hit = table[key];
		return { code: hit?.code ?? (hit ? 0 : null), stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '', error: hit ? hit.error : 'ENOENT' };
	});
}

describe('parsers', () => {
	it('parseVersion reads the real version outputs', () => {
		expect(parseVersion('2.1.282 (Claude Code)')).toBe('2.1.282');
		expect(parseVersion('codex-cli 0.156.1')).toBe('0.156.1');
		expect(parseVersion('0.9.0-preview.1')).toBe('0.9.0-preview.1');
		expect(parseVersion('no version')).toBeNull();
	});

	it('compareVersions compares numerically', () => {
		expect(compareVersions('2.1.282', '2.1.99')).toBeGreaterThan(0);
		expect(compareVersions('0.156.1', '0.157.0')).toBeLessThan(0);
		expect(compareVersions('1.0.0', '1.0')).toBe(0);
		expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0);
	});

	it('parseCodexLoginSource classifies without returning the key', () => {
		expect(parseCodexLoginSource('Logged in using ChatGPT')).toBe('chatgpt');
		expect(parseCodexLoginSource('Logged in using an API key - sk-proj-***abc')).toBe('api_key');
		expect(parseCodexLoginSource('Logged in')).toBe('codex');
	});
});

describe('HarnessStatusService', () => {
	let home: string;
	let credentials: HarnessCredentialsStore;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-status-'));
		credentials = new HarnessCredentialsStore(path.join(home, 'creds.json'));
	});
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	/**
	 * Build a service.
	 *
	 * @param overrides - Deps overrides
	 * @returns Service
	 */
	function make(overrides: Partial<ConstructorParameters<typeof HarnessStatusService>[0]> = {}): HarnessStatusService {
		return new HarnessStatusService({
			env: { PATH: '/usr/bin' },
			homeDir: home,
			platform: 'linux',
			credentials,
			resolveCommand: (cmd) => (['claude', 'codex', 'jq'].includes(cmd) ? `/usr/bin/${cmd}` : null),
			run: fakeRun({
				'claude --version': { stdout: '2.1.282 (Claude Code)\n' },
				'codex --version': { stdout: 'codex-cli 0.156.1\n' },
				'npm view @anthropic-ai/claude-code version': { stdout: '2.1.300\n' },
				'npm view @openai/codex version': { stdout: '0.156.1\n' },
				'npm view @google/gemini-cli version': { stdout: '0.9.0\n' },
				'codex login status': { code: 1, stdout: 'Not logged in\n' },
			}),
			...overrides,
		});
	}

	it('reports installed version, latest version and update availability', async () => {
		const service = make();
		const claude = await service.getStatus('claude-code');
		expect(claude).toMatchObject({
			id: 'claude-code',
			displayName: 'Claude Code',
			installed: true,
			version: '2.1.282',
			latestVersion: '2.1.300',
			updateAvailable: true,
			loginState: 'logged_out',
			loginSource: null,
		});
		expect(claude.loginMethods.map((m) => m.id)).toEqual(['subscription', 'api_key']);
		const codex = await service.getStatus('codex-cli');
		expect(codex).toMatchObject({ installed: true, version: '0.156.1', updateAvailable: false, loginState: 'logged_out' });
		const gemini = await service.getStatus('gemini-cli');
		expect(gemini).toMatchObject({ installed: false, version: null, latestVersion: '0.9.0', updateAvailable: false, loginState: 'unknown', loginMethods: [], retired: true });
		expect(claude.retired).toBe(false);
	});

	it('reports Antigravity CLI from `agy --version` with no latest version (no npm package) and API-key login only', async () => {
		const run = fakeRun({ 'agy --version': { stdout: '1.2.11\n' } });
		const status = await make({ run, resolveCommand: (cmd) => (cmd === 'agy' ? `${home}/.local/bin/agy` : null) }).getStatus('antigravity-cli');
		expect(status).toMatchObject({
			id: 'antigravity-cli',
			displayName: 'Antigravity CLI',
			installed: true,
			version: '1.2.11',
			latestVersion: null,
			updateAvailable: false,
			loginState: 'logged_out',
			retired: false,
			loginMethods: [{ id: 'api_key', label: 'Gemini API key', kind: 'api_key' }],
		});
		expect(run.mock.calls.some(([cmd, args]) => cmd === 'npm' && args.includes('view'))).toBe(false);
	});

	it('a binary whose --version crashes is installed with an unknown version', async () => {
		const run = fakeRun({ 'codex --version': { code: 1, stderr: 'Error: Cannot find module\n\nNode.js v22.14.0\n' } });
		expect(await make({ run }).getStatus('codex-cli')).toMatchObject({ installed: true, version: null, updateAvailable: false });
	});

	it('lists all four harnesses in order', async () => {
		expect((await make().listStatuses()).map((s) => s.id)).toEqual(['claude-code', 'codex-cli', 'antigravity-cli', 'gemini-cli']);
	});

	it('caches npm view results', async () => {
		const run = fakeRun({ 'npm view @openai/codex version': { stdout: '1.0.0' } });
		let now = 0;
		const service = make({ run, now: () => now });
		const def = getHarnessDefinition('codex-cli')!;
		expect(await service.getLatestVersion(def)).toBe('1.0.0');
		expect(await service.getLatestVersion(def)).toBe('1.0.0');
		expect(run).toHaveBeenCalledTimes(1);
		now += 2 * 60 * 60 * 1000;
		await service.getLatestVersion(def);
		expect(run).toHaveBeenCalledTimes(2);
		service.clearLatestVersionCache();
		await service.getLatestVersion(def);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('caches a failed npm view for a shorter time', async () => {
		const run = fakeRun({});
		let now = 0;
		const service = make({ run, now: () => now });
		const def = getHarnessDefinition('codex-cli')!;
		expect(await service.getLatestVersion(def)).toBeNull();
		now += 60 * 1000;
		await service.getLatestVersion(def);
		expect(run).toHaveBeenCalledTimes(1);
		now += 10 * 60 * 1000;
		await service.getLatestVersion(def);
		expect(run).toHaveBeenCalledTimes(2);
	});

	describe('Claude login', () => {
		it('prefers the credential Crewly stores', async () => {
			credentials.setClaudeOauthToken('sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxx');
			expect(await make().getStatus('claude-code')).toMatchObject({ loginState: 'logged_in', loginSource: 'crewly-subscription' });
			credentials.setAnthropicApiKey('sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx');
			expect(await make().getStatus('claude-code')).toMatchObject({ loginState: 'logged_in', loginSource: 'crewly-api-key' });
		});

		it('reports env vars by name only', async () => {
			const status = await make({ env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret' } }).getStatus('claude-code');
			expect(status).toMatchObject({ loginState: 'logged_in', loginSource: 'env:ANTHROPIC_API_KEY' });
			expect(JSON.stringify(status)).not.toContain('sk-ant-secret');
		});

		it('finds the Linux credentials file', async () => {
			fs.mkdirSync(path.join(home, '.claude'));
			fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
			expect(await make().getStatus('claude-code')).toMatchObject({ loginState: 'logged_in', loginSource: 'claude-credentials-file' });
		});

		it('checks the macOS keychain item by existence only', async () => {
			const run = fakeRun({ 'security find-generic-password -s Claude Code-credentials': { code: 0 } });
			const status = await make({ platform: 'darwin', run }).getStatus('claude-code');
			expect(status).toMatchObject({ loginState: 'logged_in', loginSource: 'macos-keychain' });
			const call = run.mock.calls.find(([cmd]) => cmd === 'security');
			expect(call?.[1]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']);
			expect(call?.[1]).not.toContain('-w');
			expect(call?.[1]).not.toContain('-g');
		});

		it('keychain exit 44 means logged out; other failures mean unknown', async () => {
			const notFound = fakeRun({ 'security find-generic-password -s Claude Code-credentials': { code: 44 } });
			expect((await make({ platform: 'darwin', run: notFound }).getStatus('claude-code')).loginState).toBe('logged_out');
			const locked = fakeRun({ 'security find-generic-password -s Claude Code-credentials': { code: 51 } });
			expect((await make({ platform: 'darwin', run: locked }).getStatus('claude-code')).loginState).toBe('unknown');
		});

		it('an account in ~/.claude.json alone is reported as unknown', async () => {
			fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
			expect(await make().getStatus('claude-code')).toMatchObject({ loginState: 'unknown', loginSource: 'claude-config' });
		});
	});

	describe('Codex login', () => {
		it('uses codex login status', async () => {
			const run = fakeRun({ 'codex login status': { code: 0, stdout: 'Logged in using ChatGPT\n' } });
			expect(await make({ run }).getStatus('codex-cli')).toMatchObject({ loginState: 'logged_in', loginSource: 'chatgpt' });
		});

		it('falls back to auth.json when the status command cannot run', async () => {
			const run = fakeRun({});
			fs.mkdirSync(path.join(home, '.codex'));
			fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
			expect(await make({ run }).getStatus('codex-cli')).toMatchObject({ loginState: 'logged_in', loginSource: 'codex-auth-file' });
		});

		it('honours CODEX_HOME and reports unknown when nothing is known', async () => {
			const run = fakeRun({});
			expect((await make({ run, env: { PATH: '/usr/bin', CODEX_HOME: path.join(home, 'ch') } }).getStatus('codex-cli')).loginState).toBe('unknown');
			fs.mkdirSync(path.join(home, 'ch'));
			fs.writeFileSync(path.join(home, 'ch', 'auth.json'), '{}');
			expect((await make({ run, env: { PATH: '/usr/bin', CODEX_HOME: path.join(home, 'ch') } }).getStatus('codex-cli')).loginState).toBe('logged_in');
		});

		it('not installed and no auth file means logged out', async () => {
			const status = await make({ resolveCommand: () => null }).getStatus('codex-cli');
			expect(status).toMatchObject({ installed: false, loginState: 'logged_out' });
		});
	});

	describe('Antigravity login (Gemini API key only)', () => {
		it('prefers the key Crewly stores', async () => {
			credentials.setAntigravityGeminiApiKey(`AIzaSy${'k'.repeat(33)}`);
			const status = await make().getStatus('antigravity-cli');
			expect(status).toMatchObject({ loginState: 'logged_in', loginSource: 'crewly-api-key' });
			expect(JSON.stringify(status)).not.toContain('AIzaSy');
		});

		it('reports GEMINI_API_KEY in the env by name only', async () => {
			const status = await make({ env: { PATH: '/usr/bin', GEMINI_API_KEY: 'AIza-secret' } }).getStatus('antigravity-cli');
			expect(status).toMatchObject({ loginState: 'logged_in', loginSource: 'env:GEMINI_API_KEY' });
			expect(JSON.stringify(status)).not.toContain('AIza-secret');
		});

		it('ignores keys agy does not read and never counts an account login', async () => {
			// agy reads only GEMINI_API_KEY; an account session in its keyring is not usable by Crewly (policy).
			const status = await make({ env: { PATH: '/usr/bin', GOOGLE_API_KEY: 'x', GOOGLE_GENERATIVE_AI_API_KEY: 'y' } }).getStatus('antigravity-cli');
			expect(status).toMatchObject({ loginState: 'logged_out', loginSource: null });
		});
	});

	describe('Gemini login (detect only)', () => {
		it('finds Google-login credentials or an API key env var', async () => {
			expect((await make({ env: { PATH: '/usr/bin', GEMINI_API_KEY: 'x' } }).getStatus('gemini-cli')).loginSource).toBe('env:GEMINI_API_KEY');
			fs.mkdirSync(path.join(home, '.gemini'));
			fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{}');
			expect((await make().getStatus('gemini-cli')).loginSource).toBe('gemini-google-login');
		});
	});

	it('login detection errors become unknown', async () => {
		const broken = { getClaudeCredentialKind: () => { throw new Error('boom'); } } as unknown as HarnessCredentialsStore;
		expect((await make({ credentials: broken }).getStatus('claude-code')).loginState).toBe('unknown');
	});

	it('rejects an unknown harness id', async () => {
		await expect(make().getStatus('nope' as never)).rejects.toThrow('Unknown harness');
	});

	it('reports jq with a platform install hint', () => {
		expect(make().getSystemTools()).toEqual([{ id: 'jq', installed: true, installHint: expect.stringContaining('apt-get') }]);
		expect(make({ platform: 'darwin', resolveCommand: () => null }).getSystemTools()).toEqual([
			{ id: 'jq', installed: false, installHint: 'brew install jq' },
		]);
	});
});

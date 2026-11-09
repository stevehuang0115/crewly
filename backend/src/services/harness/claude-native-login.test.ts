/**
 * Tests for Claude Code's own login state: env without tokens, the CLI's
 * `auth status`, the cache, and the real-turn probe classification.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	cachedClaudeNativeLogin,
	classifyNativeProbe,
	nativeLoginEnv,
	probeClaudeNativeLogin,
	readClaudeAuthStatus,
	refreshClaudeNativeLogins,
	resetClaudeNativeLoginCache,
	setCachedClaudeNativeLogin,
} from './claude-native-login.js';
import { HARNESS_CONSTANTS } from '../../constants.js';

const BASE_ENV = {
	PATH: '/usr/bin',
	CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-should-not-leak',
	ANTHROPIC_API_KEY: 'sk-ant-api03-should-not-leak',
	CREWLY_API_TOKEN: 'crewly-token',
	CLAUDECODE: '1',
};

describe('claude-native-login', () => {
	let scratch: string;

	beforeEach(() => {
		resetClaudeNativeLoginCache();
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'native-login-'));
	});

	afterEach(() => {
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	describe('nativeLoginEnv', () => {
		it('strips every token, key and nested-session variable and keeps the rest', () => {
			const env = nativeLoginEnv(BASE_ENV, '/cfg/work');
			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.CREWLY_API_TOKEN).toBeUndefined();
			expect(env.CLAUDECODE).toBeUndefined();
			expect(env.PATH).toBe('/usr/bin');
			expect(env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV]).toBe('/cfg/work');
		});

		it('leaves CLAUDE_CONFIG_DIR as it was for the default login (null)', () => {
			const env = nativeLoginEnv({ ...BASE_ENV, CLAUDE_CONFIG_DIR: '/elsewhere' }, null);
			expect(env.CLAUDE_CONFIG_DIR).toBe('/elsewhere');
		});

		it('does not mutate the env it was given', () => {
			nativeLoginEnv(BASE_ENV, '/cfg');
			expect(BASE_ENV.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
		});
	});

	describe('readClaudeAuthStatus', () => {
		it('asks the CLI (`auth status --json`) with a token-free env and returns loggedIn', async () => {
			const run = jest.fn(async () => ({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' }));
			const result = await readClaudeAuthStatus('/cfg/work', { run, env: BASE_ENV, resolveCommand: () => '/bin/claude' });
			expect(result).toBe(true);
			const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
			expect(file).toBe('/bin/claude');
			expect(args).toEqual(['auth', 'status', '--json']);
			expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(options.env.CLAUDE_CONFIG_DIR).toBe('/cfg/work');
		});

		it('returns false when the CLI says logged out (even with a non-zero exit)', async () => {
			const run = jest.fn(async () => ({ code: 1, stdout: '{"loggedIn":false}', stderr: '' }));
			expect(await readClaudeAuthStatus(null, { run, env: BASE_ENV, resolveCommand: () => '/bin/claude' })).toBe(false);
		});

		it('returns null (unknown) for no binary, bad JSON, a missing field or a run error', async () => {
			expect(await readClaudeAuthStatus(null, { env: BASE_ENV, resolveCommand: () => null })).toBeNull();
			const bad = jest.fn(async () => ({ code: 0, stdout: 'not json', stderr: '' }));
			expect(await readClaudeAuthStatus(null, { run: bad, env: BASE_ENV, resolveCommand: () => '/bin/claude' })).toBeNull();
			const missing = jest.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
			expect(await readClaudeAuthStatus(null, { run: missing, env: BASE_ENV, resolveCommand: () => '/bin/claude' })).toBeNull();
			const boom = jest.fn(async () => {
				throw new Error('spawn failed');
			});
			expect(await readClaudeAuthStatus(null, { run: boom, env: BASE_ENV, resolveCommand: () => '/bin/claude' })).toBeNull();
		});
	});

	describe('cache', () => {
		it('refreshClaudeNativeLogins fills the cache, keeps a fresh answer, and keeps an old answer when the CLI cannot be asked', async () => {
			let loggedIn = true;
			const run = jest.fn(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn }), stderr: '' }));
			const deps = { run, env: BASE_ENV, resolveCommand: () => '/bin/claude', now: () => 1_000 };
			const accounts = [
				{ account: 'work', configDir: '/cfg/work' },
				{ account: null, configDir: null },
			];
			await refreshClaudeNativeLogins(accounts, deps);
			expect(cachedClaudeNativeLogin('work')).toBe(true);
			expect(cachedClaudeNativeLogin(null)).toBe(true);
			expect(run).toHaveBeenCalledTimes(2);

			loggedIn = false;
			await refreshClaudeNativeLogins(accounts, { ...deps, now: () => 1_000 + 10_000 });
			expect(run).toHaveBeenCalledTimes(2); // still fresh
			await refreshClaudeNativeLogins(accounts, { ...deps, now: () => 1_000 + 120_000 });
			expect(cachedClaudeNativeLogin('work')).toBe(false);

			const broken = jest.fn(async () => {
				throw new Error('x');
			});
			await refreshClaudeNativeLogins(accounts, { ...deps, run: broken, now: () => 1_000 + 500_000 });
			expect(cachedClaudeNativeLogin('work')).toBe(false); // kept
		});

		it('is undefined until asked, and can be set and reset', () => {
			expect(cachedClaudeNativeLogin('x')).toBeUndefined();
			setCachedClaudeNativeLogin('x', true, 1);
			expect(cachedClaudeNativeLogin('x')).toBe(true);
			resetClaudeNativeLoginCache();
			expect(cachedClaudeNativeLogin('x')).toBeUndefined();
		});
	});

	describe('classifyNativeProbe', () => {
		it('exit 0 is logged_in', () => {
			expect(classifyNativeProbe({ code: 0, stdout: 'ok', stderr: '' })).toBe('logged_in');
		});

		it('a login-expiry message is logged_out, whatever the exit code', () => {
			expect(classifyNativeProbe({ code: 1, stdout: 'Not logged in · Please run /login', stderr: '' })).toBe('logged_out');
		});

		it('any other failure is unknown, never logged_in', () => {
			expect(classifyNativeProbe({ code: 1, stdout: '', stderr: 'ECONNRESET' })).toBe('unknown');
			expect(classifyNativeProbe({ code: null, stdout: '', stderr: '' })).toBe('unknown');
		});
	});

	describe('probeClaudeNativeLogin', () => {
		it('runs one real turn with the probe args and no token or key in the env', async () => {
			const run = jest.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
			const state = await probeClaudeNativeLogin('/cfg/work', { run, env: BASE_ENV, resolveCommand: () => '/bin/claude', scratchDir: scratch });
			expect(state).toBe('logged_in');
			const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; cwd: string }];
			expect(file).toBe('/bin/claude');
			expect(args).toEqual(HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS);
			expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(options.env.CLAUDE_CONFIG_DIR).toBe('/cfg/work');
			expect(options.cwd).toBe(scratch);
		});

		it('is unknown (never logged_in) when there is no binary or the run throws', async () => {
			expect(await probeClaudeNativeLogin(null, { env: BASE_ENV, resolveCommand: () => null, scratchDir: scratch })).toBe('unknown');
			const boom = jest.fn(async () => {
				throw new Error('x');
			});
			expect(await probeClaudeNativeLogin(null, { run: boom, env: BASE_ENV, resolveCommand: () => '/bin/claude', scratchDir: scratch })).toBe('unknown');
		});
	});
});

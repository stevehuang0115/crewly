/**
 * Tests for the usage probe (CLI mocked).
 */

import * as os from 'os';
import { classifyClaudeUsageProbe, classifyProviderProbe, createRuntimeUsageProbe, type ProbeFetch } from './runtime-usage-probe.js';

describe('classifyClaudeUsageProbe', () => {
	it('reads a usage limit, a normal answer and anything else', () => {
		expect(classifyClaudeUsageProbe({ code: 1, stdout: "You've hit your limit · resets 3pm (UTC)", stderr: '' })).toBe('limited');
		expect(classifyClaudeUsageProbe({ code: 0, stdout: 'OK', stderr: '' })).toBe('available');
		expect(classifyClaudeUsageProbe({ code: 1, stdout: 'Login expired · Please run /login', stderr: '' })).toBe('unknown');
		expect(classifyClaudeUsageProbe({ code: null, stdout: '', stderr: '' })).toBe('unknown');
	});

	it('reads "credit balance is too low" as limited', () => {
		expect(
			classifyClaudeUsageProbe({
				code: 1,
				stdout: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
				stderr: '',
			}),
		).toBe('limited');
	});
});

describe('createRuntimeUsageProbe', () => {
	const credentials = { harnessEnvForAgents: () => ({}) };

	it('runs one print-mode turn for Claude Code without Crewly secrets in its env', async () => {
		const run = jest.fn(async () => ({ code: 0, stdout: 'OK', stderr: '' }));
		const probe = createRuntimeUsageProbe({
			run,
			env: { PATH: '/usr/bin', CREWLY_API_TOKEN: 'secret', CLAUDECODE: '1' },
			resolveCommand: () => '/usr/local/bin/claude',
			credentials,
			scratchDir: os.tmpdir(),
		});
		await expect(probe('claude-code')).resolves.toBe('available');
		const [binary, args, opts] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
		expect(binary).toBe('/usr/local/bin/claude');
		expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku']));
		expect(opts.env.CREWLY_API_TOKEN).toBeUndefined();
		expect(opts.env.CLAUDECODE).toBeUndefined();
	});

	it('is unsupported for runtimes without a probe, unknown for a missing binary or a crash', async () => {
		const run = jest.fn(async () => {
			throw new Error('boom');
		});
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => '/x' })('codex-cli')).toBe('unsupported');
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => null })('claude-code')).toBe('unknown');
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => '/x', scratchDir: os.tmpdir() })('claude-code')).toBe('unknown');
	});
});

describe('classifyProviderProbe', () => {
	it('reads 2xx as available, 402 / a billing error as limited, anything else as unknown', () => {
		expect(classifyProviderProbe(200, '{}')).toBe('available');
		expect(classifyProviderProbe(402, '{"error":{"message":"Insufficient Balance"}}')).toBe('limited');
		expect(classifyProviderProbe(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}')).toBe('limited');
		expect(classifyProviderProbe(401, '{"error":{"message":"Authentication Fails"}}')).toBe('unknown');
		expect(classifyProviderProbe(429, 'Rate Limit Reached')).toBe('unknown');
		expect(classifyProviderProbe(500, '')).toBe('unknown');
	});
});

describe('createRuntimeUsageProbe — Crewly Agent (DeepSeek)', () => {
	function fetchReturning(status: number, body: string): jest.Mock & ProbeFetch {
		return jest.fn(async () => ({ status, text: async () => body })) as unknown as jest.Mock & ProbeFetch;
	}

	it('sends one tiny DeepSeek request and reads 402 as still limited', async () => {
		const fetch = fetchReturning(402, '{"error":{"message":"Insufficient Balance"}}');
		const probe = createRuntimeUsageProbe({
			fetch,
			crewlyAgentTargets: async () => [{ provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' }],
		});
		await expect(probe('crewly-agent')).resolves.toBe('limited');
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
		expect(url).toBe('https://api.deepseek.com/chat/completions');
		expect(init.headers.authorization).toBe('Bearer sk-test');
		expect(JSON.parse(init.body)).toMatchObject({ model: 'deepseek-chat', max_tokens: 1 });
	});

	it('is available when DeepSeek answers', async () => {
		const probe = createRuntimeUsageProbe({
			fetch: fetchReturning(200, '{"choices":[]}'),
			crewlyAgentTargets: async () => [{ provider: 'deepseek', apiKey: 'sk-test' }],
		});
		await expect(probe('crewly-agent')).resolves.toBe('available');
	});

	it('is unknown without a key, on a network error, and unsupported for a provider without a probe', async () => {
		await expect(createRuntimeUsageProbe({ fetch: fetchReturning(200, ''), crewlyAgentTargets: async () => [] })('crewly-agent')).resolves.toBe('unknown');
		const failing = jest.fn(async () => {
			throw new Error('ECONNRESET');
		}) as unknown as ProbeFetch;
		await expect(
			createRuntimeUsageProbe({ fetch: failing, crewlyAgentTargets: async () => [{ provider: 'deepseek', apiKey: 'k' }] })('crewly-agent'),
		).resolves.toBe('unknown');
		await expect(
			createRuntimeUsageProbe({ fetch: fetchReturning(200, ''), crewlyAgentTargets: async () => [{ provider: 'google', apiKey: 'k' }] })('crewly-agent'),
		).resolves.toBe('unsupported');
	});
});

describe('createRuntimeUsageProbe — Claude Code accounts (#942)', () => {
	it("probes an account with its config dir and token, not the default login's", async () => {
		const run = jest.fn(async () => ({ code: 0, stdout: 'OK', stderr: '' }));
		const probe = createRuntimeUsageProbe({
			run,
			env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-default' },
			resolveCommand: () => '/usr/local/bin/claude',
			credentials: { harnessEnvForAgents: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'default-token' }) },
			accountEnv: (account) => ({ CLAUDE_CONFIG_DIR: `/acc/${account}`, CLAUDE_CODE_OAUTH_TOKEN: 'b-token', ANTHROPIC_API_KEY: '' }),
			scratchDir: os.tmpdir(),
		});
		await expect(probe('claude-code@b')).resolves.toBe('available');
		const [, , opts] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
		expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/acc/b');
		expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('b-token');
		expect('ANTHROPIC_API_KEY' in opts.env).toBe(false);
	});

	it('drops an empty account token instead of passing it', async () => {
		const run = jest.fn(async () => ({ code: 1, stdout: 'Not logged in · Please run /login', stderr: '' }));
		const probe = createRuntimeUsageProbe({
			run,
			env: { PATH: '/usr/bin' },
			resolveCommand: () => '/x',
			credentials: { harnessEnvForAgents: () => ({}) },
			accountEnv: () => ({ CLAUDE_CONFIG_DIR: '/acc/c', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' }),
			scratchDir: os.tmpdir(),
		});
		await expect(probe('claude-code@c')).resolves.toBe('unknown');
		const [, , opts] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
		expect('CLAUDE_CODE_OAUTH_TOKEN' in opts.env).toBe(false);
	});
});

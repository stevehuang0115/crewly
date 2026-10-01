/**
 * Tests for the usage probe (CLI mocked).
 */

import * as os from 'os';
import { classifyClaudeUsageProbe, createRuntimeUsageProbe } from './runtime-usage-probe.js';

describe('classifyClaudeUsageProbe', () => {
	it('reads a usage limit, a normal answer and anything else', () => {
		expect(classifyClaudeUsageProbe({ code: 1, stdout: "You've hit your limit · resets 3pm (UTC)", stderr: '' })).toBe('limited');
		expect(classifyClaudeUsageProbe({ code: 0, stdout: 'OK', stderr: '' })).toBe('available');
		expect(classifyClaudeUsageProbe({ code: 1, stdout: 'Login expired · Please run /login', stderr: '' })).toBe('unknown');
		expect(classifyClaudeUsageProbe({ code: null, stdout: '', stderr: '' })).toBe('unknown');
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

	it('is unknown for other runtimes, a missing binary or a crash', async () => {
		const run = jest.fn(async () => {
			throw new Error('boom');
		});
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => '/x' })('codex-cli')).toBe('unknown');
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => null })('claude-code')).toBe('unknown');
		expect(await createRuntimeUsageProbe({ run, credentials, resolveCommand: () => '/x', scratchDir: os.tmpdir() })('claude-code')).toBe('unknown');
	});
});

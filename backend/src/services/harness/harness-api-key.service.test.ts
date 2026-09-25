/**
 * Tests for API-key logins (fetch and exec mocked; the key never leaks).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessApiKeyService, isPlausibleApiKey, type FetchLike } from './harness-api-key.service.js';
import { HarnessCredentialsStore } from './harness-credentials.store.js';
import type { RunCommand } from './harness.types.js';

const ANTHROPIC_KEY = `sk-ant-api03-${'k'.repeat(80)}`;
const OPENAI_KEY = `sk-proj-${'o'.repeat(60)}`;

describe('isPlausibleApiKey', () => {
	it('checks length and whitespace', () => {
		expect(isPlausibleApiKey(ANTHROPIC_KEY)).toBe(true);
		expect(isPlausibleApiKey('short')).toBe(false);
		expect(isPlausibleApiKey(`${ANTHROPIC_KEY} extra`)).toBe(false);
		expect(isPlausibleApiKey('x'.repeat(600))).toBe(false);
	});
});

describe('HarnessApiKeyService', () => {
	let dir: string;
	let credentials: HarnessCredentialsStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-apikey-'));
		credentials = new HarnessCredentialsStore(path.join(dir, 'creds.json'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	/**
	 * Build a service.
	 *
	 * @param overrides - Deps overrides
	 * @returns Service plus its mocks
	 */
	function make(overrides: Partial<ConstructorParameters<typeof HarnessApiKeyService>[0]> = {}) {
		const fetchFn = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => ({ status: 200 }));
		const run = jest.fn<ReturnType<RunCommand>, Parameters<RunCommand>>(async () => ({ code: 0, stdout: 'Successfully logged in', stderr: '' }));
		const prepareClaudeConfig = jest.fn();
		const service = new HarnessApiKeyService({
			fetchFn,
			run,
			credentials,
			prepareClaudeConfig,
			env: { PATH: '/usr/bin' },
			resolveCommand: (cmd) => `/usr/bin/${cmd}`,
			...overrides,
		});
		return { service, fetchFn, run, prepareClaudeConfig };
	}

	it('checks an Anthropic key, stores it and pre-approves it in Claude config', async () => {
		const { service, fetchFn, prepareClaudeConfig } = make();
		await service.submit('claude-code', `  ${ANTHROPIC_KEY}\n`);
		expect(credentials.read().claude?.anthropicApiKey).toBe(ANTHROPIC_KEY);
		expect(prepareClaudeConfig).toHaveBeenCalledWith(ANTHROPIC_KEY);
		expect(fetchFn).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': ANTHROPIC_KEY }) }));
	});

	it('rejects a key Anthropic refuses', async () => {
		const { service } = make({ fetchFn: async () => ({ status: 401 }) });
		await expect(service.submit('claude-code', ANTHROPIC_KEY)).rejects.toMatchObject({ code: 'invalid_key' });
		expect(credentials.getClaudeCredentialKind()).toBeNull();
	});

	it('still saves a well-formed key when Anthropic cannot be reached', async () => {
		const { service } = make({ fetchFn: async () => { throw new Error('offline'); } });
		await service.submit('claude-code', ANTHROPIC_KEY);
		expect(credentials.getClaudeCredentialKind()).toBe('api_key');
		expect(await make({ fetchFn: async () => ({ status: 529 }) }).service.checkAnthropicKey(ANTHROPIC_KEY)).toBe('unverified');
	});

	it('rejects keys that are not Anthropic keys or not keys at all', async () => {
		const { service, fetchFn } = make();
		await expect(service.submit('claude-code', OPENAI_KEY)).rejects.toMatchObject({ code: 'invalid_key' });
		await expect(service.submit('claude-code', 'nope')).rejects.toMatchObject({ code: 'invalid_key' });
		await expect(service.submit('claude-code', 42)).rejects.toMatchObject({ code: 'invalid_key' });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('does not break the login when Claude config cannot be updated', async () => {
		const { service } = make({ prepareClaudeConfig: () => { throw new Error('read-only'); } });
		await expect(service.submit('claude-code', ANTHROPIC_KEY)).resolves.toBeUndefined();
	});

	it('logs Codex in with the key on stdin, never in argv', async () => {
		const { service, run } = make();
		await service.submit('codex-cli', OPENAI_KEY);
		const [command, args, options] = run.mock.calls[0];
		expect(command).toBe('/usr/bin/codex');
		expect(args).toEqual(['login', '--with-api-key']);
		expect(args.join(' ')).not.toContain(OPENAI_KEY);
		expect(options?.stdin).toBe(`${OPENAI_KEY}\n`);
		expect(credentials.read().codex).toBeUndefined();
	});

	it('reports a Codex refusal without echoing the key', async () => {
		const { service } = make({ run: async () => ({ code: 1, stdout: '', stderr: `Error: invalid key ${OPENAI_KEY}` }) });
		const error = await service.submit('codex-cli', OPENAI_KEY).catch((e: Error & { code: string }) => e);
		expect(error).toMatchObject({ code: 'login_failed' });
		expect((error as Error).message).not.toContain(OPENAI_KEY);
		expect((error as Error).message).toContain('[redacted]');
		const bare = await make({ run: async () => ({ code: 1, stdout: '', stderr: '' }) }).service.submit('codex-cli', OPENAI_KEY).catch((e: Error) => e);
		expect((bare as Error).message).toBe('Codex did not accept the key');
	});

	it('needs Codex installed', async () => {
		const { service } = make({ resolveCommand: () => null });
		await expect(service.submit('codex-cli', OPENAI_KEY)).rejects.toMatchObject({ code: 'not_installed' });
	});

	it('rejects unknown harnesses and Gemini (detect only)', async () => {
		const { service } = make();
		await expect(service.submit('nope', OPENAI_KEY)).rejects.toMatchObject({ code: 'unknown_harness' });
		await expect(service.submit('gemini-cli', OPENAI_KEY)).rejects.toMatchObject({ code: 'unsupported' });
	});
});

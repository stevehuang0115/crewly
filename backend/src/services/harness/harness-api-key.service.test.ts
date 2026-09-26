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
const GEMINI_KEY = `AIzaSy${'g'.repeat(33)}`;

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
		// Never the real ~/.gemini: every test gets a mocked settings writer.
		const prepareAntigravitySettings = jest.fn(async () => 'written' as const);
		const service = new HarnessApiKeyService({
			fetchFn,
			run,
			credentials,
			prepareClaudeConfig,
			prepareAntigravitySettings,
			env: { PATH: '/usr/bin' },
			resolveCommand: (cmd) => `/usr/bin/${cmd}`,
			...overrides,
		});
		return { service, fetchFn, run, prepareClaudeConfig, prepareAntigravitySettings };
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

	it('checks an Antigravity Gemini key with the key in a header, stores it and forces the API-key provider', async () => {
		const { service, fetchFn, run, prepareAntigravitySettings } = make();
		await service.submit('antigravity-cli', ` ${GEMINI_KEY} `);
		expect(credentials.getAntigravityGeminiApiKey()).toBe(GEMINI_KEY);
		expect(prepareAntigravitySettings).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
		expect(url).not.toContain(GEMINI_KEY);
		expect(init.headers).toEqual({ 'x-goog-api-key': GEMINI_KEY });
		// No agy login command is ever run: the key is the whole login.
		expect(run).not.toHaveBeenCalled();
	});

	it.each([400, 401, 403])('rejects a Gemini key the API refuses with %d and stores nothing', async (status) => {
		const { service, prepareAntigravitySettings } = make({ fetchFn: async () => ({ status }) });
		await expect(service.submit('antigravity-cli', GEMINI_KEY)).rejects.toMatchObject({ code: 'invalid_key' });
		expect(credentials.getAntigravityGeminiApiKey()).toBeNull();
		expect(prepareAntigravitySettings).not.toHaveBeenCalled();
	});

	it('still saves a well-formed Gemini key when the API cannot be reached or answers oddly', async () => {
		const { service } = make({ fetchFn: async () => { throw new Error('offline'); } });
		await service.submit('antigravity-cli', GEMINI_KEY);
		expect(credentials.getAntigravityGeminiApiKey()).toBe(GEMINI_KEY);
		expect(await make({ fetchFn: async () => ({ status: 429 }) }).service.checkGeminiKey(GEMINI_KEY)).toBe('unverified');
		expect(await make({ fetchFn: async () => ({ status: 503 }) }).service.checkGeminiKey(GEMINI_KEY)).toBe('unverified');
	});

	it('reports an unreadable agy settings file (the key stays saved) without echoing the key', async () => {
		const { service } = make({ prepareAntigravitySettings: async () => 'unparseable' });
		const error = await service.submit('antigravity-cli', GEMINI_KEY).catch((e: Error & { code: string }) => e);
		expect(error).toMatchObject({ code: 'login_failed' });
		expect((error as Error).message).toContain('settings.json');
		expect((error as Error).message).not.toContain(GEMINI_KEY);
		expect(credentials.getAntigravityGeminiApiKey()).toBe(GEMINI_KEY);
	});

	it('does not fail the login when agy settings cannot be written now (retried at launch)', async () => {
		const { service } = make({ prepareAntigravitySettings: async () => 'error' });
		await expect(service.submit('antigravity-cli', GEMINI_KEY)).resolves.toBeUndefined();
	});

	it('rejects a non-key for Antigravity before calling the API', async () => {
		const { service, fetchFn } = make();
		await expect(service.submit('antigravity-cli', 'short')).rejects.toMatchObject({ code: 'invalid_key' });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('rejects unknown harnesses and Gemini (detect only)', async () => {
		const { service } = make();
		await expect(service.submit('nope', OPENAI_KEY)).rejects.toMatchObject({ code: 'unknown_harness' });
		await expect(service.submit('gemini-cli', OPENAI_KEY)).rejects.toMatchObject({ code: 'unsupported' });
	});
});

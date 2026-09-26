/**
 * Tests for the harness credentials store: 0600 file under CREWLY_HOME,
 * one active Claude credential, agent env, and no secret in any log.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessCredentialsStore, getHarnessCredentialsStore, harnessEnvForAgents } from './harness-credentials.store.js';

const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}`;
const API_KEY = `sk-ant-api03-${'b'.repeat(90)}`;
const GEMINI_KEY = `AIzaSy${'c'.repeat(33)}`;

describe('HarnessCredentialsStore', () => {
	let home: string;
	const originalHome = process.env.CREWLY_HOME;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-creds-'));
		process.env.CREWLY_HOME = home;
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		process.env.CREWLY_HOME = originalHome;
		jest.restoreAllMocks();
	});

	it('resolves the file under CREWLY_HOME per call', () => {
		expect(new HarnessCredentialsStore().getFilePath()).toBe(path.join(home, 'harness-credentials.json'));
		expect(getHarnessCredentialsStore().getFilePath()).toBe(path.join(home, 'harness-credentials.json'));
	});

	it('reads an empty object when the file is missing or corrupt', () => {
		const store = new HarnessCredentialsStore();
		expect(store.read()).toEqual({});
		fs.writeFileSync(store.getFilePath(), 'not json');
		expect(store.read()).toEqual({});
		fs.writeFileSync(store.getFilePath(), '[1,2]');
		expect(store.read()).toEqual({});
	});

	it('writes the file with mode 0600, even over a wider existing file', () => {
		const store = new HarnessCredentialsStore();
		fs.writeFileSync(store.getFilePath(), '{}', { mode: 0o644 });
		store.setClaudeOauthToken(TOKEN);
		expect(fs.statSync(store.getFilePath()).mode & 0o777).toBe(0o600);
		expect(store.read().claude?.oauthToken).toBe(TOKEN);
		expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});

	it('keeps exactly one Claude credential: the latest one', () => {
		const store = new HarnessCredentialsStore();
		store.setClaudeOauthToken(TOKEN);
		expect(store.getClaudeCredentialKind()).toBe('oauth_token');
		store.setAnthropicApiKey(API_KEY);
		expect(store.getClaudeCredentialKind()).toBe('api_key');
		expect(store.read().claude?.oauthToken).toBeUndefined();
		store.setClaudeOauthToken(TOKEN);
		expect(store.read().claude?.anthropicApiKey).toBeUndefined();
	});

	it('keeps the Codex entry when Claude changes, and clears Claude only', () => {
		const store = new HarnessCredentialsStore();
		store.setOpenaiApiKey('sk-openai-key-1234567890');
		store.setClaudeOauthToken(TOKEN);
		expect(store.read().codex?.openaiApiKey).toBe('sk-openai-key-1234567890');
		store.clearClaude();
		expect(store.getClaudeCredentialKind()).toBeNull();
		expect(store.read().codex?.openaiApiKey).toBe('sk-openai-key-1234567890');
		store.clearClaude();
	});

	it('rejects empty credentials', () => {
		const store = new HarnessCredentialsStore();
		expect(() => store.setClaudeOauthToken('  ')).toThrow('empty');
		expect(() => store.setAnthropicApiKey('')).toThrow('empty');
		expect(() => store.setOpenaiApiKey('')).toThrow('empty');
	});

	it('exports the OAuth token or the API key to agents, plus the harness PATH', () => {
		const store = new HarnessCredentialsStore();
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' })).toEqual({ PATH: expect.stringContaining('/usr/bin') });
		store.setClaudeOauthToken(TOKEN);
		const env = store.harnessEnvForAgents({ PATH: '/usr/bin' });
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.PATH.split(':')[0]).toBe(path.join(home, 'npm-global', 'bin'));
		store.setAnthropicApiKey(API_KEY);
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' })).toMatchObject({ ANTHROPIC_API_KEY: API_KEY });
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it('stores the Antigravity Gemini key next to the Claude credential and clears it alone', () => {
		const store = new HarnessCredentialsStore();
		expect(store.getAntigravityGeminiApiKey()).toBeNull();
		store.setClaudeOauthToken(TOKEN);
		store.setAntigravityGeminiApiKey(`  ${GEMINI_KEY}  `);
		expect(store.getAntigravityGeminiApiKey()).toBe(GEMINI_KEY);
		expect(store.read().claude?.oauthToken).toBe(TOKEN);
		store.clearAntigravity();
		expect(store.getAntigravityGeminiApiKey()).toBeNull();
		expect(store.read().claude?.oauthToken).toBe(TOKEN);
		expect(() => store.setAntigravityGeminiApiKey(' ')).toThrow();
	});

	it('exports GEMINI_API_KEY only to antigravity-cli sessions, with agy auto-update off', () => {
		const store = new HarnessCredentialsStore();
		store.setAntigravityGeminiApiKey(GEMINI_KEY);
		const agy = store.harnessEnvForAgents({ PATH: '/usr/bin' }, 'antigravity-cli');
		expect(agy.GEMINI_API_KEY).toBe(GEMINI_KEY);
		expect(agy.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
		// A Gemini CLI (Google login) session must not suddenly see a key.
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' }, 'gemini-cli').GEMINI_API_KEY).toBeUndefined();
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' }, 'claude-code').GEMINI_API_KEY).toBeUndefined();
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' }).GEMINI_API_KEY).toBeUndefined();
		expect(harnessEnvForAgents({ PATH: '/bin' }, 'antigravity-cli').GEMINI_API_KEY).toBe(GEMINI_KEY);
	});

	it('does not invent a key for an antigravity session when none is stored', () => {
		const env = new HarnessCredentialsStore().harnessEnvForAgents({ PATH: '/usr/bin' }, 'antigravity-cli');
		expect(env.GEMINI_API_KEY).toBeUndefined();
		expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
	});

	it('module-level harnessEnvForAgents uses the default store and never throws', () => {
		new HarnessCredentialsStore().setClaudeOauthToken(TOKEN);
		expect(harnessEnvForAgents({ PATH: '/bin' }).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
		jest.spyOn(HarnessCredentialsStore.prototype, 'harnessEnvForAgents').mockImplementation(() => {
			throw new Error('boom');
		});
		expect(harnessEnvForAgents({ PATH: '/bin' })).toEqual({ PATH: expect.stringContaining('/bin') });
	});

	it('never writes a secret to the console', () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
		const store = new HarnessCredentialsStore();
		store.setClaudeOauthToken(TOKEN);
		store.setAnthropicApiKey(API_KEY);
		store.setAntigravityGeminiApiKey(GEMINI_KEY);
		store.harnessEnvForAgents(process.env, 'antigravity-cli');
		for (const spy of spies) {
			for (const call of spy.mock.calls) {
				expect(JSON.stringify(call)).not.toContain('sk-ant-');
				expect(JSON.stringify(call)).not.toContain(GEMINI_KEY);
			}
		}
	});
});

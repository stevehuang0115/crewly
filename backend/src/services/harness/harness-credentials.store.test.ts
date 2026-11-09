/**
 * Tests for the harness credentials store: 0600 file under CREWLY_HOME,
 * agent env, and no secret in any log. Crewly no longer WRITES a Claude
 * sign-in token (there is no setter); an older Crewly's saved token is only
 * read, handed over during the migration and then removed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessCredentialsStore, getHarnessCredentialsStore, harnessEnvForAgents } from './harness-credentials.store.js';

const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}`;
const API_KEY = `sk-ant-api03-${'b'.repeat(90)}`;
const GEMINI_KEY = `AIzaSy${'c'.repeat(33)}`;

/** Put a token where an older Crewly saved it (the store has no setter for it). */
function seedLegacy(store: HarnessCredentialsStore, seed: { defaultToken?: string; accounts?: Record<string, string> }): void {
	const current = store.read();
	store.write({
		...current,
		...(seed.defaultToken ? { claude: { ...(current.claude ?? {}), oauthToken: seed.defaultToken, updatedAt: 'then' } } : {}),
		...(seed.accounts ? { claudeAccounts: Object.fromEntries(Object.entries(seed.accounts).map(([n, t]) => [n, { oauthToken: t, updatedAt: 'then' }])) } : {}),
	});
}

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
		store.setAnthropicApiKey(API_KEY);
		expect(fs.statSync(store.getFilePath()).mode & 0o777).toBe(0o600);
		expect(store.read().claude?.anthropicApiKey).toBe(API_KEY);
		expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});

	it('has no way to save a Claude sign-in token any more', () => {
		const store = new HarnessCredentialsStore() as unknown as Record<string, unknown>;
		expect(store.setClaudeOauthToken).toBeUndefined();
		expect(store.setClaudeAccountToken).toBeUndefined();
	});

	it('an API key replaces a legacy default token', () => {
		const store = new HarnessCredentialsStore();
		seedLegacy(store, { defaultToken: TOKEN });
		expect(store.getClaudeCredentialKind()).toBe('oauth_token');
		store.setAnthropicApiKey(API_KEY);
		expect(store.getClaudeCredentialKind()).toBe('api_key');
		expect(store.read().claude?.oauthToken).toBeUndefined();
	});

	it("keeps legacy accounts' tokens apart from the default login (#942) and deletes them one by one", () => {
		const store = new HarnessCredentialsStore();
		seedLegacy(store, { defaultToken: TOKEN, accounts: { b: 'tok-b', c: 'tok-c' } });
		expect(store.getClaudeAccountToken('b')).toBe('tok-b');
		expect(store.listClaudeAccountsWithToken()).toEqual(['b', 'c']);
		expect(store.getLegacyClaudeOauthToken()).toBe(TOKEN);
		// Accounts never reach the default agent env.
		expect(Object.values(store.harnessEnvForAgents({ PATH: '/usr/bin' }, 'claude-code'))).not.toContain('tok-b');
		store.clearClaudeAccount('b');
		expect(store.getClaudeAccountToken('b')).toBeNull();
		expect(store.listClaudeAccountsWithToken()).toEqual(['c']);
		store.clearClaudeAccount('nope');
		store.clearClaudeAccount('c');
		// The last account takes the `claudeAccounts` key with it; the default token stays.
		expect(store.read().claudeAccounts).toBeUndefined();
		expect(store.getLegacyClaudeOauthToken()).toBe(TOKEN);
		expect(fs.statSync(store.getFilePath()).mode & 0o777).toBe(0o600);
	});

	it('legacyClaudeTokenEnv hands over a saved token for its own login only, and nothing once deleted', () => {
		const store = new HarnessCredentialsStore();
		expect(store.legacyClaudeTokenEnv(null)).toEqual({});
		seedLegacy(store, { defaultToken: TOKEN, accounts: { work: 'tok-w' } });
		expect(store.legacyClaudeTokenEnv(null)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
		expect(store.legacyClaudeTokenEnv('work')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-w' });
		expect(store.legacyClaudeTokenEnv('other')).toEqual({});
		store.clearLegacyClaudeOauthToken();
		store.clearClaudeAccount('work');
		expect(store.legacyClaudeTokenEnv(null)).toEqual({});
		expect(store.legacyClaudeTokenEnv('work')).toEqual({});
	});

	it('clearLegacyClaudeOauthToken keeps a stored API key and drops an otherwise empty claude key', () => {
		const store = new HarnessCredentialsStore();
		store.write({ claude: { oauthToken: TOKEN, anthropicApiKey: API_KEY, updatedAt: 'then' } });
		store.clearLegacyClaudeOauthToken();
		expect(store.read().claude).toEqual({ anthropicApiKey: API_KEY, updatedAt: 'then' });
		seedLegacy(store, { defaultToken: TOKEN });
		store.write({ claude: { oauthToken: TOKEN, updatedAt: 'then' } });
		store.clearLegacyClaudeOauthToken();
		expect(store.read().claude).toBeUndefined();
		store.clearLegacyClaudeOauthToken();
	});

	it('pruneLegacyClaudeKeys removes empty leftovers, leaves other keys alone and does not rewrite a clean file', () => {
		const store = new HarnessCredentialsStore();
		store.write({
			claude: { updatedAt: 'then' },
			claudeAccounts: { gone: { updatedAt: 'then' } },
			codex: { openaiApiKey: 'sk-openai-key-1234567890' },
			antigravity: { geminiApiKey: GEMINI_KEY },
		});
		store.pruneLegacyClaudeKeys();
		expect(store.read()).toEqual({ codex: { openaiApiKey: 'sk-openai-key-1234567890' }, antigravity: { geminiApiKey: GEMINI_KEY } });
		const before = fs.statSync(store.getFilePath()).mtimeMs;
		store.pruneLegacyClaudeKeys();
		expect(fs.statSync(store.getFilePath()).mtimeMs).toBe(before);
		// A real token is never pruned.
		seedLegacy(store, { accounts: { keep: 'tok' } });
		store.pruneLegacyClaudeKeys();
		expect(store.getClaudeAccountToken('keep')).toBe('tok');
	});

	it('keeps the Codex entry when Claude changes, and clears Claude only', () => {
		const store = new HarnessCredentialsStore();
		store.setOpenaiApiKey('sk-openai-key-1234567890');
		store.setAnthropicApiKey(API_KEY);
		expect(store.read().codex?.openaiApiKey).toBe('sk-openai-key-1234567890');
		store.clearClaude();
		expect(store.getClaudeCredentialKind()).toBeNull();
		expect(store.read().codex?.openaiApiKey).toBe('sk-openai-key-1234567890');
		store.clearClaude();
	});

	it('rejects empty credentials', () => {
		const store = new HarnessCredentialsStore();
		expect(() => store.setAnthropicApiKey('')).toThrow('empty');
		expect(() => store.setOpenaiApiKey('')).toThrow('empty');
	});

	it('exports the API key to agents, plus the harness PATH; a legacy token only while one is saved', () => {
		const store = new HarnessCredentialsStore();
		expect(store.harnessEnvForAgents({ PATH: '/usr/bin' })).toEqual({ PATH: expect.stringContaining('/usr/bin') });
		seedLegacy(store, { defaultToken: TOKEN });
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
		store.setAnthropicApiKey(API_KEY);
		store.setAntigravityGeminiApiKey(`  ${GEMINI_KEY}  `);
		expect(store.getAntigravityGeminiApiKey()).toBe(GEMINI_KEY);
		expect(store.read().claude?.anthropicApiKey).toBe(API_KEY);
		store.clearAntigravity();
		expect(store.getAntigravityGeminiApiKey()).toBeNull();
		expect(store.read().claude?.anthropicApiKey).toBe(API_KEY);
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
		new HarnessCredentialsStore().setAnthropicApiKey(API_KEY);
		expect(harnessEnvForAgents({ PATH: '/bin' }).ANTHROPIC_API_KEY).toBe(API_KEY);
		jest.spyOn(HarnessCredentialsStore.prototype, 'harnessEnvForAgents').mockImplementation(() => {
			throw new Error('boom');
		});
		expect(harnessEnvForAgents({ PATH: '/bin' })).toEqual({ PATH: expect.stringContaining('/bin') });
	});

	it('never writes a secret to the console', () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
		const store = new HarnessCredentialsStore();
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

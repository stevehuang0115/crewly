/**
 * Tests for AI-runtime install + login detection (#779).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	checkAntigravityAuth,
	checkClaudeAuth,
	checkCodexAuth,
	checkGeminiAuth,
	checkRuntimeAuth,
	findAntigravityKey,
	findCrewlyGeminiKey,
	type RuntimeAuthDeps,
} from './runtime-auth.js';

let home: string;

/** Deps with the given binaries installed. */
function deps(installed: string[], env: NodeJS.ProcessEnv = {}): RuntimeAuthDeps {
	const set = new Set(installed);
	return { which: (bin) => set.has(bin), homeDir: home, env };
}

/** Write a JSON file under home, creating directories. */
function writeJson(rel: string, value: unknown): void {
	const file = path.join(home, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-runtime-auth-'));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe('checkClaudeAuth', () => {
	it('reports not installed with the install + login command', () => {
		const status = checkClaudeAuth(deps([]));
		expect(status).toMatchObject({ installed: false, loggedIn: false, detail: 'not installed' });
		expect(status.fix).toContain('npm install -g @anthropic-ai/claude-code');
	});

	it('is not logged in before first-run setup (#782), even with an API key in the env', () => {
		expect(checkClaudeAuth(deps(['claude'], { ANTHROPIC_API_KEY: 'k' }))).toMatchObject({
			loggedIn: false,
			detail: expect.stringContaining('never set up'),
		});
	});

	it('is logged in after setup with an OAuth account or an API-key login', () => {
		writeJson('.claude.json', { hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'x' } });
		expect(checkClaudeAuth(deps(['claude']))).toMatchObject({ loggedIn: true, detail: 'set up and logged in (account login)' });
		writeJson('.claude.json', { hasCompletedOnboarding: true, primaryApiKey: 'sk-secret' });
		const status = checkClaudeAuth(deps(['claude']));
		expect(status).toMatchObject({ loggedIn: true, detail: 'set up and logged in (API key login)' });
		expect(JSON.stringify(status)).not.toContain('sk-secret');
	});

	it('accepts a credentials file, an apiKeyHelper, or an auth env var', () => {
		writeJson('.claude.json', { hasCompletedOnboarding: true });
		writeJson('.claude/.credentials.json', {});
		expect(checkClaudeAuth(deps(['claude'])).detail).toContain('credentials file');
		fs.rmSync(path.join(home, '.claude', '.credentials.json'));
		writeJson('.claude/settings.json', { apiKeyHelper: '/bin/get-key' });
		expect(checkClaudeAuth(deps(['claude'])).detail).toContain('apiKeyHelper');
		fs.rmSync(path.join(home, '.claude', 'settings.json'));
		expect(checkClaudeAuth(deps(['claude'], { CLAUDE_CODE_OAUTH_TOKEN: 't' })).detail).toContain('$CLAUDE_CODE_OAUTH_TOKEN');
	});

	it('is logged out when set up but no credential is found', () => {
		writeJson('.claude.json', { hasCompletedOnboarding: true });
		expect(checkClaudeAuth(deps(['claude']))).toMatchObject({ loggedIn: false, detail: expect.stringContaining('no login found'), fix: expect.stringContaining('/login') });
	});

	it('reads everything from CLAUDE_CONFIG_DIR when set', () => {
		const dir = path.join(home, 'cfg');
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
		fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
		expect(checkClaudeAuth(deps(['claude'], { CLAUDE_CONFIG_DIR: dir }))).toMatchObject({ loggedIn: true });
	});
});

describe('checkCodexAuth', () => {
	it('is logged in with ChatGPT tokens or an API key in auth.json', () => {
		writeJson('.codex/auth.json', { OPENAI_API_KEY: null, tokens: { id_token: 'x' } });
		expect(checkCodexAuth(deps(['codex']))).toMatchObject({ loggedIn: true, detail: 'logged in (ChatGPT account)' });
		writeJson('.codex/auth.json', { OPENAI_API_KEY: 'sk-secret', tokens: null });
		const status = checkCodexAuth(deps(['codex']));
		expect(status).toMatchObject({ loggedIn: true, detail: 'logged in (API key)' });
		expect(JSON.stringify(status)).not.toContain('sk-secret');
	});

	it('is not logged in without auth.json, and honours CODEX_HOME', () => {
		expect(checkCodexAuth(deps(['codex']))).toMatchObject({ loggedIn: false, fix: expect.stringContaining('codex login') });
		const alt = path.join(home, 'alt-codex');
		fs.mkdirSync(alt);
		fs.writeFileSync(path.join(alt, 'auth.json'), JSON.stringify({ tokens: { a: 1 } }));
		expect(checkCodexAuth(deps(['codex'], { CODEX_HOME: alt }))).toMatchObject({ loggedIn: true });
	});

	it('reports not installed', () => {
		expect(checkCodexAuth(deps([]))).toMatchObject({ installed: false, loggedIn: false, fix: expect.stringContaining('npm install -g @openai/codex') });
	});
});

describe('checkGeminiAuth', () => {
	it('is ready with a Gemini key and no saved method: Crewly pre-selects API-key auth (#781)', () => {
		expect(checkGeminiAuth(deps(['gemini'], { GEMINI_API_KEY: 'k' }))).toMatchObject({
			loggedIn: true,
			detail: expect.stringContaining('Crewly selects "Use Gemini API Key" at launch'),
		});
	});

	it('is not logged in with no key and no saved method', () => {
		expect(checkGeminiAuth(deps(['gemini']))).toMatchObject({ loggedIn: false, detail: 'no login and no Gemini API key' });
	});

	it('needs a key when set to API-key auth (also in the legacy top-level key)', () => {
		writeJson('.gemini/settings.json', { security: { auth: { selectedType: 'gemini-api-key' } } });
		expect(checkGeminiAuth(deps(['gemini']))).toMatchObject({ loggedIn: false, detail: expect.stringContaining('no Gemini API key') });
		writeJson('.gemini/settings.json', { selectedAuthType: 'gemini-api-key' });
		expect(checkGeminiAuth(deps(['gemini'], { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }))).toMatchObject({ loggedIn: true });
	});

	it('needs saved Google credentials when set to Login with Google', () => {
		writeJson('.gemini/settings.json', { security: { auth: { selectedType: 'oauth-personal' } } });
		expect(checkGeminiAuth(deps(['gemini']))).toMatchObject({ loggedIn: false, fix: expect.stringContaining('sign in with Google') });
		writeJson('.gemini/oauth_creds.json', {});
		expect(checkGeminiAuth(deps(['gemini']))).toMatchObject({ loggedIn: true, detail: 'logged in (Google account)' });
	});

	it('accepts other configured auth methods (e.g. Vertex AI)', () => {
		writeJson('.gemini/settings.json', { security: { auth: { selectedType: 'vertex-ai' } } });
		expect(checkGeminiAuth(deps(['gemini']))).toMatchObject({ loggedIn: true, detail: 'auth method "vertex-ai" configured' });
	});
});

describe('findCrewlyGeminiKey', () => {
	it('finds a global key, a gemini-cli override, or the env — never returning the value', () => {
		writeJson('.crewly/settings.json', { apiKeys: { global: { gemini: 'secret' } } });
		expect(findCrewlyGeminiKey(deps([]))).toBe('Crewly settings');
		writeJson('.crewly/settings.json', { apiKeys: { global: {}, runtimeOverrides: { 'gemini-cli': { gemini: { source: 'custom', key: 'secret' } } } } });
		expect(findCrewlyGeminiKey(deps([]))).toBe('Crewly settings (Gemini runtime key)');
		writeJson('.crewly/settings.json', { apiKeys: { global: {} } });
		expect(findCrewlyGeminiKey(deps([], { GEMINI_API_KEY: 'secret' }))).toBe('$GEMINI_API_KEY');
		expect(findCrewlyGeminiKey(deps([]))).toBeNull();
	});
});

describe('checkAntigravityAuth', () => {
	it('is not installed without agy on PATH, and the fix is the official installer', () => {
		const status = checkAntigravityAuth(deps([]));
		expect(status).toMatchObject({ id: 'antigravity', displayName: 'Antigravity CLI', installed: false, loggedIn: false });
		expect(status.fix).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
		expect(status.fix).toContain('crewly login antigravity');
	});

	it('needs a Gemini API key — an account login does not count', () => {
		// An agy account login lives in the OS keyring; Crewly never uses it.
		writeJson('.gemini/antigravity-cli/settings.json', {});
		const status = checkAntigravityAuth(deps(['agy']));
		expect(status).toMatchObject({ installed: true, loggedIn: false });
		expect(status.detail).toContain('only with an API key');
	});

	it('finds the key saved in Crewly, a settings key or GEMINI_API_KEY — never returning the value', () => {
		writeJson('.crewly/harness-credentials.json', { antigravity: { geminiApiKey: 'AIza-secret' } });
		const status = checkAntigravityAuth(deps(['agy']));
		expect(status).toMatchObject({ loggedIn: true, detail: 'Gemini API key (saved in Crewly)' });
		expect(JSON.stringify(status)).not.toContain('AIza-secret');
		fs.rmSync(path.join(home, '.crewly', 'harness-credentials.json'));
		writeJson('.crewly/settings.json', { apiKeys: { global: {}, runtimeOverrides: { 'antigravity-cli': { gemini: { source: 'custom', key: 'k' } } } } });
		expect(findAntigravityKey(deps([]))).toBe('Crewly settings (Antigravity runtime key)');
		writeJson('.crewly/settings.json', { apiKeys: { global: { gemini: 'k' } } });
		expect(findAntigravityKey(deps([]))).toBe('Crewly settings');
		writeJson('.crewly/settings.json', {});
		expect(findAntigravityKey(deps([], { GEMINI_API_KEY: 'k' }))).toBe('$GEMINI_API_KEY');
		// agy reads only GEMINI_API_KEY
		expect(findAntigravityKey(deps([], { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }))).toBeNull();
	});

	it('honours CREWLY_HOME', () => {
		const other = path.join(home, 'custom-home');
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(other, 'harness-credentials.json'), JSON.stringify({ antigravity: { geminiApiKey: 'k' } }));
		expect(findAntigravityKey(deps([], { CREWLY_HOME: other }))).toBe('saved in Crewly');
	});
});

describe('checkRuntimeAuth', () => {
	it('returns Claude, Codex, Antigravity, Gemini in order, with Gemini marked retired', () => {
		const statuses = checkRuntimeAuth(deps([]));
		expect(statuses.map((s) => s.id)).toEqual(['claude', 'codex', 'antigravity', 'gemini']);
		expect(statuses.find((s) => s.id === 'gemini')?.retired).toBe(true);
		expect(statuses.find((s) => s.id === 'antigravity')?.retired).toBeUndefined();
	});
});

/**
 * Tests for the owner's other Claude Code accounts (issue #942).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ClaudeAccountNameError,
	accountOf,
	baseRuntimeOf,
	claudeAccountConfigDir,
	claudeAccountEnv,
	describeClaudeAccounts,
	ensureClaudeAccountDir,
	isClaudeAccountSignedIn,
	isClaudeAccountTarget,
	isValidClaudeAccountName,
	listClaudeAccounts,
	parseRuntimeTarget,
	prepareClaudeAccountAfterLogin,
	removeClaudeAccount,
	requireClaudeAccountName,
	runtimeTarget,
} from './claude-accounts.js';
import { HarnessCredentialsStore } from './harness-credentials.store.js';

describe('claude-accounts', () => {
	let home: string;
	let crewlyHome: string;
	let credentials: HarnessCredentialsStore;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
		crewlyHome = path.join(home, '.crewly');
		credentials = new HarnessCredentialsStore(path.join(crewlyHome, 'harness-credentials.json'));
	});

	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	describe('names and targets', () => {
		it('accepts simple lower-case names and refuses reserved or unsafe ones', () => {
			expect(isValidClaudeAccountName('work')).toBe(true);
			expect(isValidClaudeAccountName('b')).toBe(true);
			expect(isValidClaudeAccountName('acct_2-x')).toBe(true);
			for (const bad of ['', 'Work', '../x', 'a b', '-x', 'code', 'default', 'claude', 'x'.repeat(33)]) {
				expect(isValidClaudeAccountName(bad)).toBe(false);
			}
		});

		it('normalises a name or throws', () => {
			expect(requireClaudeAccountName(' Work ')).toBe('work');
			expect(() => requireClaudeAccountName('a/b')).toThrow(ClaudeAccountNameError);
			expect(() => requireClaudeAccountName(42)).toThrow(ClaudeAccountNameError);
		});

		it('splits and builds runtime targets', () => {
			expect(parseRuntimeTarget('claude-code@work')).toEqual({ runtime: 'claude-code', account: 'work' });
			expect(parseRuntimeTarget('crewly-agent')).toEqual({ runtime: 'crewly-agent' });
			expect(baseRuntimeOf('claude-code@work')).toBe('claude-code');
			expect(accountOf('claude-code@work')).toBe('work');
			expect(accountOf('claude-code')).toBeNull();
			expect(runtimeTarget('claude-code', 'work')).toBe('claude-code@work');
			expect(runtimeTarget('claude-code', null)).toBe('claude-code');
		});

		it('only Claude Code with a valid name is an account target', () => {
			expect(isClaudeAccountTarget('claude-code@work')).toBe(true);
			expect(isClaudeAccountTarget('claude-code')).toBe(false);
			expect(isClaudeAccountTarget('codex-cli@work')).toBe(false);
			expect(isClaudeAccountTarget('claude-code@../x')).toBe(false);
		});
	});

	describe('accounts on disk', () => {
		it('lists accounts from config dirs and stored tokens', () => {
			expect(listClaudeAccounts({ crewlyHome, credentials })).toEqual([]);
			fs.mkdirSync(claudeAccountConfigDir('work', crewlyHome), { recursive: true });
			fs.mkdirSync(claudeAccountConfigDir('Not-Valid', crewlyHome), { recursive: true });
			credentials.setClaudeAccountToken('b', 'tok-b');
			expect(listClaudeAccounts({ crewlyHome, credentials })).toEqual(['b', 'work']);
		});

		it('is signed in with a stored token or a credentials file', () => {
			expect(isClaudeAccountSignedIn('work', { crewlyHome, credentials })).toBe(false);
			credentials.setClaudeAccountToken('work', 'tok');
			expect(isClaudeAccountSignedIn('work', { crewlyHome, credentials })).toBe(true);
			const dir = claudeAccountConfigDir('manual', crewlyHome);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
			expect(isClaudeAccountSignedIn('manual', { crewlyHome, credentials })).toBe(true);
			expect(describeClaudeAccounts({ crewlyHome, credentials })).toEqual([
				{ name: 'manual', target: 'claude-code@manual', signedIn: true, configDir: dir },
				{ name: 'work', target: 'claude-code@work', signedIn: true, configDir: claudeAccountConfigDir('work', crewlyHome) },
			]);
		});

		it('builds the env: its config dir and token, default credentials blanked', () => {
			credentials.setClaudeAccountToken('work', 'tok-w');
			expect(claudeAccountEnv('work', { crewlyHome, credentials })).toEqual({
				CLAUDE_CONFIG_DIR: claudeAccountConfigDir('work', crewlyHome),
				CLAUDE_CODE_OAUTH_TOKEN: 'tok-w',
				ANTHROPIC_API_KEY: '',
			});
			expect(claudeAccountEnv('none', { crewlyHome, credentials }).CLAUDE_CODE_OAUTH_TOKEN).toBe('');
		});

		it('creates a dir with the owner\'s settings and first-run answers, no credentials', () => {
			const defaultDir = path.join(home, '.claude');
			fs.mkdirSync(defaultDir, { recursive: true });
			fs.writeFileSync(path.join(defaultDir, 'settings.json'), '{"skipDangerousModePermissionPrompt":true}');
			fs.writeFileSync(path.join(defaultDir, '.credentials.json'), '{"secret":1}');
			fs.writeFileSync(
				path.join(home, '.claude.json'),
				JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, oauthAccount: { emailAddress: 'a@b' }, projects: {} }),
			);
			const dir = ensureClaudeAccountDir('work', { crewlyHome, defaultEnv: {}, homeDir: home });
			expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toContain('skipDangerousModePermissionPrompt');
			expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'))).toEqual({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true });
			expect(fs.existsSync(path.join(dir, '.credentials.json'))).toBe(false);
			// Existing dirs are left alone.
			fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
			ensureClaudeAccountDir('work', { crewlyHome, defaultEnv: {}, homeDir: home });
			expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('{}');
		});

		it('works without a default login to copy from', () => {
			const dir = ensureClaudeAccountDir('fresh', { crewlyHome, defaultEnv: {}, homeDir: home });
			expect(fs.readdirSync(dir)).toEqual([]);
		});

		it('records onboarding as done in the account after a login', () => {
			prepareClaudeAccountAfterLogin('work', crewlyHome);
			const config = JSON.parse(fs.readFileSync(path.join(claudeAccountConfigDir('work', crewlyHome), '.claude.json'), 'utf-8'));
			expect(config.hasCompletedOnboarding).toBe(true);
		});

		it('removes the token and the dir', () => {
			credentials.setClaudeAccountToken('work', 'tok');
			fs.mkdirSync(claudeAccountConfigDir('work', crewlyHome), { recursive: true });
			removeClaudeAccount('work', { crewlyHome, credentials });
			expect(credentials.getClaudeAccountToken('work')).toBeNull();
			expect(fs.existsSync(claudeAccountConfigDir('work', crewlyHome))).toBe(false);
		});
	});
});

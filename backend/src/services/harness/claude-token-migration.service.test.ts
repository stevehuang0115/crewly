/**
 * Tests for the Claude token migration: a saved token keeps working until the
 * account is signed in natively, is deleted only after a real probe passes, and
 * the credentials file is cleaned without touching other keys.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeTokenMigrationService } from './claude-token-migration.service.js';
import { resetClaudeNativeLoginCache } from './claude-native-login.js';
import { HarnessCredentialsStore } from './harness-credentials.store.js';
import type { LoginState } from './harness.types.js';

const DEFAULT_TOKEN = `sk-ant-oat01-${'Aa1'.repeat(30)}-AA`;
const ACCOUNT_TOKEN = `sk-ant-oat01-${'Bb2'.repeat(30)}-BB`;
const API_KEY = `sk-ant-api03-${'Cc3'.repeat(20)}`;

describe('ClaudeTokenMigrationService', () => {
	let dir: string;
	let credentialsFile: string;
	let store: HarnessCredentialsStore;
	let probe: jest.Mock<Promise<LoginState>, [string | null]>;
	let readStatus: jest.Mock<Promise<boolean | null>, [string | null]>;
	let sent: string[];
	let delivered: boolean;

	/** Put tokens where an older Crewly saved them (the store has no setter any more). */
	function seed(extra: Record<string, unknown> = {}, opts: { defaultToken?: boolean; accounts?: Record<string, string> } = { defaultToken: true, accounts: { work: ACCOUNT_TOKEN } }): void {
		store.write({
			...(opts.defaultToken ? { claude: { oauthToken: DEFAULT_TOKEN, updatedAt: 'then' } } : {}),
			...(opts.accounts ? { claudeAccounts: Object.fromEntries(Object.entries(opts.accounts).map(([n, t]) => [n, { oauthToken: t, updatedAt: 'then' }])) } : {}),
			...extra,
		} as never);
	}

	function make(): ClaudeTokenMigrationService {
		return new ClaudeTokenMigrationService({
			credentials: store,
			probe,
			readStatus,
			accountConfigDir: (account) => path.join(dir, 'accounts', account),
			notifier: () => ({
				sendToOwner: async (text: string) => {
					sent.push(text);
					return delivered;
				},
			}),
			crewlyHome: dir,
		});
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-migration-'));
		credentialsFile = path.join(dir, 'harness-credentials.json');
		store = new HarnessCredentialsStore(credentialsFile);
		probe = jest.fn(async (_configDir: string | null) => 'logged_in' as LoginState);
		readStatus = jest.fn(async (_configDir: string | null) => false as boolean | null);
		sent = [];
		delivered = true;
		resetClaudeNativeLoginCache();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('before a native login: nothing is deleted, tokens still work, the owner is told once', async () => {
		seed();
		const service = make();
		const first = await service.run();
		expect(first).toEqual({ retired: [], pending: [null, 'work'], notified: true });
		expect(store.legacyClaudeTokenEnv(null)).not.toEqual({});
		expect(store.legacyClaudeTokenEnv('work')).not.toEqual({});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain('login claude work');
		expect(sent[0]).toContain('The default Claude login');
		// Once per machine: a second run (even from a new service) says nothing.
		const second = await make().run();
		expect(second.notified).toBe(false);
		expect(sent).toHaveLength(1);
		expect(probe).not.toHaveBeenCalled();
	});

	it('the notice and the state file carry no token, and the state file is 0600', async () => {
		seed();
		await make().run();
		const stateFile = path.join(dir, 'claude-token-migration.json');
		const state = fs.readFileSync(stateFile, 'utf-8');
		expect(state).not.toContain(DEFAULT_TOKEN);
		expect(state).not.toContain(ACCOUNT_TOKEN);
		expect(sent.join('')).not.toContain(ACCOUNT_TOKEN);
		expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
	});

	it('a notice that was not delivered is retried on the next run', async () => {
		seed();
		delivered = false;
		const service = make();
		expect((await service.run()).notified).toBe(false);
		delivered = true;
		expect((await service.run()).notified).toBe(true);
		expect(sent).toHaveLength(2);
	});

	it('a named account that is signed in natively is retired, but only after a real probe passes', async () => {
		seed();
		readStatus.mockImplementation(async (configDir) => configDir !== null);
		const result = await make().run();
		expect(result.retired).toEqual(['work']);
		expect(probe).toHaveBeenCalledWith(path.join(dir, 'accounts', 'work'));
		expect(store.getClaudeAccountToken('work')).toBeNull();
		// The default login is never guessed: its token stays until a Crewly sign-in.
		expect(result.pending).toEqual([null]);
		expect(store.legacyClaudeTokenEnv(null)).not.toEqual({});
	});

	it('an unverified probe (logged_out or unknown) keeps the token', async () => {
		seed();
		readStatus.mockResolvedValue(true);
		for (const state of ['logged_out', 'unknown'] as LoginState[]) {
			probe.mockResolvedValue(state);
			const result = await make().run();
			expect(result.retired).toEqual([]);
			expect(store.getClaudeAccountToken('work')).toBe(ACCOUNT_TOKEN);
		}
	});

	it('`claude auth status` saying signed-out keeps the token without probing', async () => {
		seed();
		readStatus.mockResolvedValue(false);
		await make().run();
		expect(probe).not.toHaveBeenCalled();
		expect(store.getClaudeAccountToken('work')).toBe(ACCOUNT_TOKEN);
	});

	it('afterLogin retires the default token after a verified probe, and leaves it when the probe fails', async () => {
		seed();
		const service = make();
		probe.mockResolvedValue('unknown');
		await service.afterLogin(null);
		expect(store.getLegacyClaudeOauthToken()).toBe(DEFAULT_TOKEN);
		probe.mockResolvedValue('logged_in');
		await service.afterLogin(null);
		expect(probe).toHaveBeenLastCalledWith(null);
		expect(store.getLegacyClaudeOauthToken()).toBeNull();
		// The other account is untouched.
		expect(store.getClaudeAccountToken('work')).toBe(ACCOUNT_TOKEN);
	});

	it('afterLogin for a named account retires only that account', async () => {
		seed({}, { defaultToken: true, accounts: { work: ACCOUNT_TOKEN, home: 'tok-home' } });
		await make().afterLogin('work');
		expect(store.listClaudeAccountsWithToken()).toEqual(['home']);
		expect(store.getLegacyClaudeOauthToken()).toBe(DEFAULT_TOKEN);
	});

	it('when no token remains the claude keys go; other keys are untouched; the file stays 0600 with no backup', async () => {
		seed({ anthropicApiKey: { apiKey: API_KEY, updatedAt: 'then' }, someOtherKey: { keep: true } }, { defaultToken: true, accounts: { work: ACCOUNT_TOKEN } });
		const service = make();
		await service.afterLogin(null);
		await service.afterLogin('work');
		const after = JSON.parse(fs.readFileSync(credentialsFile, 'utf-8'));
		expect(after.claude).toBeUndefined();
		expect(after.claudeAccounts).toBeUndefined();
		expect(after.anthropicApiKey).toEqual({ apiKey: API_KEY, updatedAt: 'then' });
		expect(after.someOtherKey).toEqual({ keep: true });
		expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600);
		// No leftover temp or backup file holds a token.
		const files = fs.readdirSync(dir);
		for (const name of files) {
			expect(fs.readFileSync(path.join(dir, name), 'utf-8')).not.toContain(DEFAULT_TOKEN);
			expect(fs.readFileSync(path.join(dir, name), 'utf-8')).not.toContain(ACCOUNT_TOKEN);
		}
		expect(files.filter((name) => /bak|backup|\.tmp$/i.test(name))).toEqual([]);
	});

	it('is idempotent: running again after everything is retired changes nothing and does not probe', async () => {
		seed();
		readStatus.mockResolvedValue(true);
		const service = make();
		await service.afterLogin(null);
		await service.run();
		const before = fs.readFileSync(credentialsFile, 'utf-8');
		probe.mockClear();
		const again = await service.run();
		expect(again).toEqual({ retired: [], pending: [], notified: false });
		expect(probe).not.toHaveBeenCalled();
		expect(fs.readFileSync(credentialsFile, 'utf-8')).toBe(before);
		expect(sent).toHaveLength(0);
	});

	it('a machine that never had a token is left alone: no file written, no notice', async () => {
		const result = await make().run();
		expect(result).toEqual({ retired: [], pending: [], notified: false });
		expect(fs.existsSync(credentialsFile)).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it('concurrent runs share one run', async () => {
		seed();
		const service = make();
		const [a, b] = await Promise.all([service.run(), service.run()]);
		expect(a).toBe(b);
		expect(sent).toHaveLength(1);
	});

	it('a failing probe never rejects and keeps the token', async () => {
		seed();
		readStatus.mockResolvedValue(true);
		probe.mockRejectedValue(new Error('boom'));
		await expect(make().run()).resolves.toMatchObject({ retired: [] });
		expect(store.getClaudeAccountToken('work')).toBe(ACCOUNT_TOKEN);
		await expect(make().afterLogin('work')).resolves.toBeUndefined();
		expect(store.getClaudeAccountToken('work')).toBe(ACCOUNT_TOKEN);
	});
});

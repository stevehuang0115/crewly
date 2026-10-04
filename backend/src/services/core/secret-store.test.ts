/**
 * Tests for the secret store (specs/2026-10-04-agent-credential-isolation.md).
 * The keychain store runs against a fake `security`: no real keychain is touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SpawnSyncReturns } from 'child_process';
import {
	KeychainSecretStore,
	FileSecretStore,
	LegacySecretStore,
	decodeStoredValue,
	encodeStoredValue,
	getSecretsDir,
	keychainServiceName,
	quoteForSecurityShell,
	resolveSecretStoreKind,
	type SecurityRunner,
} from './secret-store.js';

/** A spawnSync-shaped result. */
function result(status: number | null, stdout = '', stderr = '', extra: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null, ...extra } as SpawnSyncReturns<string>;
}

/** A fake `security` that keeps items in memory and records every call. */
function fakeSecurity() {
	const items = new Map<string, string>();
	const calls: Array<{ args: string[]; input?: string }> = [];
	const run: SecurityRunner = (args, input) => {
		calls.push({ args, input });
		if (args[0] === 'find-generic-password') {
			const key = `${args[2]}|${args[4]}`;
			return items.has(key) ? result(0, `${items.get(key)}\n`) : result(44, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
		}
		if (args[0] === 'delete-generic-password') {
			const key = `${args[2]}|${args[4]}`;
			return items.delete(key) ? result(0) : result(44);
		}
		if (args[0] === '-i') {
			const m = /^add-generic-password (-U )?-s (\S+) -a "([^"]*)" -l \S+ -w (\S+)\n$/.exec(input ?? '');
			if (!m) return result(0, '', 'security: unknown command');
			const key = `${m[2]}|${m[3]}`;
			if (!m[1] && items.has(key)) return result(0, '', 'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.');
			items.set(key, m[4]);
			return result(0);
		}
		return result(1, '', 'unexpected');
	};
	return { items, calls, run };
}

describe('value encoding', () => {
	it('round-trips any string and refuses a foreign value', () => {
		const v = 'eyJh.tok en "with" quotes\nand newline';
		expect(decodeStoredValue(encodeStoredValue(v))).toBe(v);
		expect(encodeStoredValue(v)).toMatch(/^b64:[A-Za-z0-9+/=]+$/);
		expect(decodeStoredValue('plain-secret')).toBeNull();
	});

	it('quotes the account for security -i and refuses a double quote', () => {
		expect(quoteForSecurityShell('/Users/a b/.crewly')).toBe('"/Users/a b/.crewly"');
		expect(() => quoteForSecurityShell('a"b')).toThrow();
	});
});

describe('KeychainSecretStore (fake security)', () => {
	const account = '/Users/test/.crewly';

	it('writes through `security -i` on stdin: the value never appears in argv', () => {
		const fake = fakeSecurity();
		const store = new KeychainSecretStore(account, fake.run);
		expect(store.set('vault-key', 'S3CRET-VALUE')).toBe('written');
		const call = fake.calls[0];
		expect(call.args).toEqual(['-i']);
		expect(call.args.join(' ')).not.toContain('S3CRET');
		expect(call.input).toContain(`-s ${keychainServiceName('vault-key')}`);
		expect(call.input).not.toContain('S3CRET-VALUE');
		expect(store.get('vault-key')).toEqual({ status: 'found', value: 'S3CRET-VALUE' });
	});

	it('reports missing (exit 44) separately from an error', () => {
		const fake = fakeSecurity();
		const store = new KeychainSecretStore(account, fake.run);
		expect(store.get('nope')).toEqual({ status: 'missing' });
		const broken = new KeychainSecretStore(account, () => result(51, '', 'User interaction is not allowed.'));
		expect(broken.get('x')).toMatchObject({ status: 'error' });
	});

	it('onlyIfAbsent keeps an existing item (two processes creating the key at once)', () => {
		const fake = fakeSecurity();
		const store = new KeychainSecretStore(account, fake.run);
		expect(store.set('vault-key', 'first', { onlyIfAbsent: true })).toBe('written');
		expect(store.set('vault-key', 'second', { onlyIfAbsent: true })).toBe('exists');
		expect(store.get('vault-key')).toEqual({ status: 'found', value: 'first' });
		expect(store.set('vault-key', 'third')).toBe('written');
		expect(store.get('vault-key')).toEqual({ status: 'found', value: 'third' });
	});

	it('a timeout (a dialog on a locked keychain) latches the keychain off: no second wait', () => {
		let calls = 0;
		const timedOut: SecurityRunner = () => {
			calls += 1;
			const err = Object.assign(new Error('spawnSync /usr/bin/security ETIMEDOUT'), { code: 'ETIMEDOUT' });
			return result(null, '', '', { error: err, signal: 'SIGTERM' });
		};
		const store = new KeychainSecretStore(account, timedOut);
		expect(store.get('vault-key')).toMatchObject({ status: 'error' });
		expect(store.get('vault-key')).toMatchObject({ status: 'error' });
		expect(() => store.set('vault-key', 'x')).toThrow(/timed out|killed/);
		expect(calls).toBe(1);
		expect(store.getUnavailableReason()).toMatch(/locked keychain/);
	});

	it('refuses a keychain value Crewly did not write', () => {
		const store = new KeychainSecretStore(account, () => result(0, 'not-ours\n'));
		expect(store.get('x')).toMatchObject({ status: 'error' });
	});

	it('treats a failed -i command (stderr, exit 0) as a failure', () => {
		const store = new KeychainSecretStore(account, () => result(0, '', 'security: SecKeychainItemCreateFromContent: write permissions error'));
		expect(() => store.set('x', 'v')).toThrow(/write permissions/);
	});

	it('deletes, and deleting a missing item is fine', () => {
		const fake = fakeSecurity();
		const store = new KeychainSecretStore(account, fake.run);
		store.set('a', 'v');
		store.delete('a');
		expect(store.get('a')).toEqual({ status: 'missing' });
		expect(() => store.delete('a')).not.toThrow();
	});
});

describe('FileSecretStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-secrets-'));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('stores 0600 files in a 0700 directory and reads them back', () => {
		const store = new FileSecretStore(path.join(dir, 's'));
		store.set('vault-key', 'value');
		expect(store.get('vault-key')).toEqual({ status: 'found', value: 'value' });
		expect(fs.statSync(path.join(dir, 's')).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(dir, 's', 'vault-key')).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(path.join(dir, 's', 'vault-key'), 'utf8')).not.toContain('value\n');
	});

	it('onlyIfAbsent never overwrites', () => {
		const store = new FileSecretStore(dir);
		expect(store.set('k', 'one', { onlyIfAbsent: true })).toBe('written');
		expect(store.set('k', 'two', { onlyIfAbsent: true })).toBe('exists');
		expect(store.get('k')).toEqual({ status: 'found', value: 'one' });
	});

	it('missing vs unreadable, and names cannot escape the directory', () => {
		const store = new FileSecretStore(dir);
		expect(store.get('none')).toEqual({ status: 'missing' });
		fs.writeFileSync(path.join(dir, 'raw'), 'plain');
		expect(store.get('raw')).toMatchObject({ status: 'error' });
		expect(store.get('../x')).toMatchObject({ status: 'error' });
		expect(() => store.set('../x', 'v')).toThrow();
		store.delete('none');
	});
});

describe('store selection', () => {
	it('defaults to the keychain on macOS, a file elsewhere, legacy under Jest; the env var wins', () => {
		expect(resolveSecretStoreKind({}, 'darwin')).toBe('keychain');
		expect(resolveSecretStoreKind({}, 'linux')).toBe('file');
		expect(resolveSecretStoreKind({ JEST_WORKER_ID: '1' }, 'darwin')).toBe('legacy');
		expect(resolveSecretStoreKind({ CREWLY_SECRET_STORE: 'legacy' }, 'darwin')).toBe('legacy');
		expect(resolveSecretStoreKind({ CREWLY_SECRET_STORE: 'FILE', JEST_WORKER_ID: '1' }, 'darwin')).toBe('file');
		expect(resolveSecretStoreKind({ CREWLY_SECRET_STORE: 'bogus' }, 'linux')).toBe('file');
	});

	it('the file store lives outside CREWLY_HOME unless pinned', () => {
		expect(getSecretsDir({ CREWLY_SECRETS_DIR: '/srv/x' })).toBe('/srv/x');
		expect(getSecretsDir({})).toContain(path.join('.local', 'share', 'crewly', 'secrets'));
	});

	it('the legacy store holds nothing', () => {
		const store = new LegacySecretStore();
		expect(store.get()).toEqual({ status: 'missing' });
		expect(() => store.set()).toThrow();
	});
});

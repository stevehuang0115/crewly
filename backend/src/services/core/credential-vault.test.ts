/**
 * Tests for the credential vault (specs/2026-10-04-agent-credential-isolation.md).
 * Uses a FileSecretStore in a temp dir — never a real keychain.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSecretStore, LegacySecretStore, setSecretStoreForTesting, type SecretStore } from './secret-store.js';
import {
	getVaultKey,
	readSecretBytes,
	readSecretJson,
	readSecretJsonOr,
	readSecretText,
	resetVaultKeyCache,
	sealString,
	unsealForExport,
	unsealString,
	writeSecretBytes,
	writeSecretJson,
	sealJsonForWrite,
	openSealedJson,
	CredentialVaultLockedError,
} from './credential-vault.js';

let dir: string;
let store: FileSecretStore;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-vault-'));
	store = new FileSecretStore(path.join(dir, 'secrets'));
	setSecretStoreForTesting(store);
	resetVaultKeyCache();
});

afterEach(() => {
	setSecretStoreForTesting(null);
	resetVaultKeyCache();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('seal / unseal', () => {
	it('round-trips, and a different key cannot open it', () => {
		const key = Buffer.alloc(32, 1);
		const sealed = sealString('hello', key);
		expect(sealed.startsWith('v1.')).toBe(true);
		expect(unsealString(sealed, key)).toBe('hello');
		expect(() => unsealString(sealed, Buffer.alloc(32, 2))).toThrow();
		expect(() => unsealString('nope', key)).toThrow();
	});
});

describe('vault key', () => {
	it('is created once, stored in the secret store, and reused', () => {
		const key = getVaultKey({ create: true });
		expect(key).toHaveLength(32);
		resetVaultKeyCache();
		expect(getVaultKey({ create: false })?.equals(key as Buffer)).toBe(true);
	});

	it('is not created by a plain read', () => {
		expect(getVaultKey({ create: false })).toBeNull();
		expect(store.get('vault-key')).toEqual({ status: 'missing' });
	});

	it('uses the key another process created first (onlyIfAbsent lost the race)', () => {
		const other = Buffer.alloc(32, 7).toString('base64');
		const racing: SecretStore = {
			kind: 'file',
			describe: () => 'racing store',
			get: jest.fn().mockReturnValueOnce({ status: 'missing' }).mockReturnValue({ status: 'found', value: other }),
			set: jest.fn().mockReturnValue('exists'),
			delete: jest.fn(),
		};
		expect(getVaultKey({ create: true }, racing)?.toString('base64')).toBe(other);
		expect(racing.set).toHaveBeenCalledWith('vault-key', expect.any(String), { onlyIfAbsent: true });
	});

	it('never creates a key when the store errors (a locked keychain): sealing is off instead', () => {
		const broken: SecretStore = {
			kind: 'keychain',
			describe: () => 'locked keychain',
			get: () => ({ status: 'error', message: 'User interaction is not allowed.' }),
			set: jest.fn(),
			delete: jest.fn(),
		};
		expect(getVaultKey({ create: true }, broken)).toBeNull();
		expect(broken.set).not.toHaveBeenCalled();
	});

	it('the legacy store never has a key', () => {
		expect(getVaultKey({ create: true }, new LegacySecretStore())).toBeNull();
	});
});

describe('JSON credential files', () => {
	it('keeps public fields in clear and no secret on disk; reads back the full object', () => {
		const file = path.join(dir, 'cloud', 'config.json');
		const value = { cloudUrl: 'https://api.crewlyai.com', token: 'eyJhCLOUD', refreshToken: 'eyJhREFRESH', tier: 'pro' };
		expect(writeSecretJson(file, value, ['cloudUrl', 'tier'])).toBe(true);
		const onDisk = fs.readFileSync(file, 'utf8');
		expect(onDisk).not.toContain('eyJhCLOUD');
		expect(onDisk).not.toContain('eyJhREFRESH');
		const parsed = JSON.parse(onDisk);
		expect(parsed.cloudUrl).toBe('https://api.crewlyai.com');
		expect(parsed.tier).toBe('pro');
		expect(parsed.token).toBeUndefined();
		expect(parsed.crewlySealedNote).toMatch(/not available to agents/);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(readSecretJson(file)).toEqual({ status: 'ok', value: expect.objectContaining(value), sealed: true });
	});

	it('reads a plain (never migrated) file unchanged', () => {
		const file = path.join(dir, 'plain.json');
		fs.writeFileSync(file, JSON.stringify({ token: 't' }));
		expect(readSecretJson(file)).toEqual({ status: 'ok', value: { token: 't' }, sealed: false });
	});

	it('a sealed file without its key is "locked", never "missing"', () => {
		const file = path.join(dir, 'c.json');
		writeSecretJson(file, { token: 't' });
		resetVaultKeyCache();
		fs.rmSync(path.join(dir, 'secrets'), { recursive: true });
		expect(readSecretJson(file)).toMatchObject({ status: 'locked' });
		expect(readSecretJsonOr(file, 'fallback')).toBe('fallback');
		expect(readSecretJson(path.join(dir, 'absent.json'))).toEqual({ status: 'missing' });
	});

	it('writes plain JSON when no key can be had (legacy store)', () => {
		setSecretStoreForTesting(new LegacySecretStore());
		resetVaultKeyCache();
		const file = path.join(dir, 'p.json');
		expect(writeSecretJson(file, { token: 't' })).toBe(false);
		expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ token: 't' });
	});

	it('readSecretJsonOr reports a broken file and falls back', () => {
		const file = path.join(dir, 'bad.json');
		fs.writeFileSync(file, '{not json');
		const problems: string[] = [];
		expect(readSecretJsonOr(file, null, (m) => problems.push(m))).toBeNull();
		expect(problems[0]).toMatch(/not valid JSON/);
	});
});

describe('text and binary credential files', () => {
	it('seals the API token and reads it back', () => {
		const file = path.join(dir, 'api-token');
		writeSecretBytes(file, 'abc123\n');
		expect(fs.readFileSync(file, 'utf8')).toMatch(/^crewly-sealed:v1\./);
		expect(fs.readFileSync(file, 'utf8')).not.toContain('abc123');
		expect(readSecretText(file)).toEqual({ status: 'ok', value: 'abc123\n', sealed: true });
	});

	it('keeps raw bytes (master.key) intact', () => {
		const file = path.join(dir, 'master.key');
		const key = Buffer.from([0, 255, 128, 10, 13, 0xfd]);
		writeSecretBytes(file, key);
		const back = readSecretBytes(file);
		expect(back.status === 'ok' && back.value.equals(key)).toBe(true);
	});
});

describe('unsealForExport (backup)', () => {
	it('turns sealed files back into their plain form and leaves others alone', () => {
		const j = path.join(dir, 'h.json');
		writeSecretJson(j, { claude: { oauthToken: 'tok' } });
		const out = unsealForExport(fs.readFileSync(j));
		expect(out.unsealed).toBe(true);
		expect(JSON.parse(out.data.toString('utf8'))).toEqual({ claude: { oauthToken: 'tok' } });

		const t = path.join(dir, 'api-token');
		writeSecretBytes(t, 'tok\n');
		expect(unsealForExport(fs.readFileSync(t)).data.toString('utf8')).toBe('tok\n');

		const plain = Buffer.from('{"a":1}');
		expect(unsealForExport(plain)).toEqual({ data: plain, unsealed: false });
	});
});

describe('helpers for callers with their own atomic read/write (Slack, Telegram, Cloud)', () => {
	it('sealJsonForWrite + openSealedJson round-trip; plain values pass through', () => {
		const value = { version: 1, identities: [{ agent: 'ruth', botToken: 'xoxb-secret' }] };
		const sealed = sealJsonForWrite(value, ['version']);
		expect(JSON.stringify(sealed)).not.toContain('xoxb-secret');
		expect(sealed.version).toBe(1);
		expect(openSealedJson(sealed)).toEqual(value);
		expect(openSealedJson({ a: 1 })).toEqual({ a: 1 });
		expect(openSealedJson(null)).toBeNull();
	});

	it('openSealedJson throws CredentialVaultLockedError without the key', () => {
		const sealed = sealJsonForWrite({ token: 't' });
		resetVaultKeyCache();
		fs.rmSync(path.join(dir, 'secrets'), { recursive: true });
		expect(() => openSealedJson(sealed)).toThrow(CredentialVaultLockedError);
	});

	it('sealJsonForWrite leaves the value plain with no key (legacy)', () => {
		setSecretStoreForTesting(new LegacySecretStore());
		resetVaultKeyCache();
		expect(sealJsonForWrite({ token: 't' })).toEqual({ token: 't' });
	});
});

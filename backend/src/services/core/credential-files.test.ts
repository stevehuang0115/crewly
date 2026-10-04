/**
 * Tests for the credential inventory and the first-boot migration
 * (specs/2026-10-04-agent-credential-isolation.md). FileSecretStore in a temp
 * dir stands in for the keychain.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSecretStore, LegacySecretStore, setSecretStoreForTesting } from './secret-store.js';
import { readSecretBytes, readSecretJson, resetVaultKeyCache } from './credential-vault.js';
import {
	getGuardedCredentialPaths,
	getSealedCredentialFiles,
	migrateCredentialFiles,
	type CredentialFileSpec,
} from './credential-files.js';

let dir: string;
let secrets: FileSecretStore;

/** Specs pointing into the temp dir. */
function specs(): CredentialFileSpec[] {
	return [
		{ id: 'api-token', filePath: path.join(dir, 'api-token'), format: 'text', mode: 0o600 },
		{ id: 'cloud-config', filePath: path.join(dir, 'cloud', 'config.json'), format: 'json', publicFields: ['cloudUrl', 'tier'], mode: 0o600 },
		{ id: 'master-key', filePath: path.join(dir, 'credentials', 'master.key'), format: 'binary', mode: 0o600 },
		{ id: 'absent', filePath: path.join(dir, 'absent.json'), format: 'json', mode: 0o600 },
	];
}

/** Write the plain files a pre-migration install has. */
function writePlain(): { token: string; cloud: Record<string, unknown>; master: Buffer } {
	const token = 'a'.repeat(64);
	const cloud = { cloudUrl: 'https://api.crewlyai.com', token: 'eyJhCLOUD', refreshToken: 'eyJhREFRESH', tier: 'pro', connectedAt: 'x' };
	const master = Buffer.from([1, 2, 3, 250, 251, 0]);
	fs.writeFileSync(path.join(dir, 'api-token'), `${token}\n`, { mode: 0o600 });
	fs.mkdirSync(path.join(dir, 'cloud'));
	fs.writeFileSync(path.join(dir, 'cloud', 'config.json'), JSON.stringify(cloud, null, 2));
	fs.mkdirSync(path.join(dir, 'credentials'));
	fs.writeFileSync(path.join(dir, 'credentials', 'master.key'), master);
	return { token, cloud, master };
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-credfiles-'));
	secrets = new FileSecretStore(path.join(dir, '..', `${path.basename(dir)}-secrets`));
	setSecretStoreForTesting(secrets);
	resetVaultKeyCache();
});

afterEach(() => {
	setSecretStoreForTesting(null);
	resetVaultKeyCache();
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(path.join(dir, '..', `${path.basename(dir)}-secrets`), { recursive: true, force: true });
});

describe('migrateCredentialFiles', () => {
	it('seals every plain credential file, keeps them readable, and is idempotent', () => {
		const plain = writePlain();
		const report = migrateCredentialFiles(specs());
		expect(report.keyAvailable).toBe(true);
		expect(Object.fromEntries(report.files.map((f) => [f.id, f.outcome]))).toEqual({
			'api-token': 'sealed',
			'cloud-config': 'sealed',
			'master-key': 'sealed',
			absent: 'missing',
		});

		// What an agent running `jq -r .token ~/.crewly/cloud/config.json` now gets.
		const cloudOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cloud', 'config.json'), 'utf8'));
		expect(cloudOnDisk.token).toBeUndefined();
		expect(cloudOnDisk.cloudUrl).toBe('https://api.crewlyai.com');
		expect(fs.readFileSync(path.join(dir, 'api-token'), 'utf8')).not.toContain(plain.token);

		// What the backend and CLI get.
		expect(readSecretJson(path.join(dir, 'cloud', 'config.json'))).toMatchObject({ status: 'ok', value: plain.cloud });
		const tok = readSecretBytes(path.join(dir, 'api-token'));
		expect(tok.status === 'ok' && tok.value.toString('utf8')).toBe(`${plain.token}\n`);
		const mk = readSecretBytes(path.join(dir, 'credentials', 'master.key'));
		expect(mk.status === 'ok' && mk.value.equals(plain.master)).toBe(true);

		const again = migrateCredentialFiles(specs());
		expect(again.files.filter((f) => f.id !== 'absent').every((f) => f.outcome === 'already-sealed')).toBe(true);
	});

	it('leaves everything plain when no key can be had, and creates no key when nothing needs sealing', () => {
		setSecretStoreForTesting({
			kind: 'keychain',
			describe: () => 'locked',
			get: () => ({ status: 'error', message: 'locked' }),
			set: () => { throw new Error('locked'); },
			delete: () => undefined,
		});
		writePlain();
		const report = migrateCredentialFiles(specs());
		expect(report.keyAvailable).toBe(false);
		expect(report.files.find((f) => f.id === 'api-token')?.outcome).toBe('plain');
		expect(fs.readFileSync(path.join(dir, 'api-token'), 'utf8')).toMatch(/^a+\n$/);

		setSecretStoreForTesting(secrets);
		resetVaultKeyCache();
		migrateCredentialFiles([{ id: 'absent', filePath: path.join(dir, 'nothing'), format: 'text', mode: 0o600 }]);
		expect(secrets.get('vault-key')).toEqual({ status: 'missing' });
	});

	it('does not touch a JSON credential file that is not an object', () => {
		fs.mkdirSync(path.join(dir, 'cloud'));
		fs.writeFileSync(path.join(dir, 'cloud', 'config.json'), '[1,2]');
		const report = migrateCredentialFiles(specs());
		expect(report.files.find((f) => f.id === 'cloud-config')?.outcome).toBe('failed');
		expect(fs.readFileSync(path.join(dir, 'cloud', 'config.json'), 'utf8')).toBe('[1,2]');
	});

	it('rolls back to plain files with CREWLY_SECRET_STORE=legacy (key from the platform store)', () => {
		const plain = writePlain();
		migrateCredentialFiles(specs());
		resetVaultKeyCache();
		setSecretStoreForTesting(new LegacySecretStore());
		const report = migrateCredentialFiles(specs(), { rollbackStore: secrets });
		expect(report.files.find((f) => f.id === 'api-token')?.outcome).toBe('unsealed');
		expect(fs.readFileSync(path.join(dir, 'api-token'), 'utf8')).toBe(`${plain.token}\n`);
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'cloud', 'config.json'), 'utf8'))).toEqual(plain.cloud);
		expect(fs.readFileSync(path.join(dir, 'credentials', 'master.key')).equals(plain.master)).toBe(true);
	});
});

describe('inventory', () => {
	it('lists the sealed credential files under the current homes', () => {
		const ids = getSealedCredentialFiles().map((s) => s.id);
		expect(ids).toEqual(expect.arrayContaining([
			'api-token', 'cloud-config', 'harness-credentials', 'slack-credentials',
			'slack-agent-identities', 'slack-cloud-config', 'telegram-credentials', 'credential-store-key',
		]));
	});

	it('guards the cloud directory, the sealed files, settings.json and the secret store', () => {
		const home = process.env.CREWLY_HOME as string;
		const guarded = getGuardedCredentialPaths();
		const byPath = new Map(guarded.map((g) => [g.path, g]));
		expect(byPath.get(path.resolve(home, 'cloud'))).toMatchObject({ id: 'cloud-config', isDirectory: true });
		expect(byPath.get(path.resolve(home, 'api-token'))).toMatchObject({ isDirectory: false });
		expect(byPath.get(path.resolve(home, 'settings.json'))).toMatchObject({ id: 'settings-api-keys' });
		expect(guarded.some((g) => g.id === 'secret-store')).toBe(true);
		expect(new Set(guarded.map((g) => g.path)).size).toBe(guarded.length);
	});
});

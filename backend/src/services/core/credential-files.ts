/**
 * Crewly's credential files: which ones exist, which of them the credential
 * vault seals, and the first-boot migration that seals the plain ones.
 *
 * Spec: specs/2026-10-04-agent-credential-isolation.md (layer 1, inventory).
 *
 * @module services/core/credential-files
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCrewlyHomePath } from './crewly-home.utils.js';
import { getApiTokenFilePath } from './api-token.service.js';
import {
	getVaultKey,
	getVaultKeyUnavailableReason,
	readSecretBytes,
	readSecretJson,
	writeSecretBytes,
	writeSecretJson,
	isSealedJson,
	isSealedText,
} from './credential-vault.js';
import { getSecretStore, getSecretsDir, resolveSecretStoreKind, KeychainSecretStore, FileSecretStore, type SecretStore } from './secret-store.js';
import { HARNESS_CONSTANTS, SLACK_AGENT_IDENTITY_CONSTANTS, SLACK_CLOUD_CONSTANTS, TELEGRAM_CONSTANTS, WHATSAPP_CONSTANTS } from '../../constants.js';
import { CREWLY_CONSTANTS } from '../../../../config/constants.js';

/** One credential file. */
export interface CredentialFileSpec {
	/** Short id, used in logs and as the guard's rule name. */
	id: string;
	/** Absolute path. */
	filePath: string;
	/** How it is sealed: `text`/`binary` whole-file, `json` field-wise. */
	format: 'text' | 'binary' | 'json';
	/** JSON fields kept in clear. */
	publicFields?: readonly string[];
	/** POSIX mode. */
	mode: number;
}

/**
 * `~/.crewly` as the modules that ignore CREWLY_HOME build it (Slack and
 * Telegram credentials, the encrypted credential store). On a normal install
 * it is the same directory as CREWLY_HOME.
 *
 * @returns Absolute directory
 */
function homeCrewlyDir(): string {
	return path.join(process.env.HOME || os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
}

/**
 * The credential files the vault seals. Every reader and writer of each of
 * these goes through credential-vault.ts; a file is only listed here once
 * that is true, because migration seals whatever is listed.
 *
 * @returns Specs, resolved against the current CREWLY_HOME / HOME
 */
export function getSealedCredentialFiles(): CredentialFileSpec[] {
	const home = getCrewlyHomePath();
	const legacyHome = homeCrewlyDir();
	return [
		{ id: 'api-token', filePath: getApiTokenFilePath(), format: 'text', mode: 0o600 },
		{ id: 'cloud-config', filePath: path.join(home, 'cloud', 'config.json'), format: 'json', publicFields: ['cloudUrl', 'tier', 'connectedAt'], mode: 0o600 },
		{ id: 'harness-credentials', filePath: path.join(home, HARNESS_CONSTANTS.CREDENTIALS_FILE), format: 'json', publicFields: [], mode: HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE },
		{ id: 'slack-credentials', filePath: path.join(legacyHome, 'slack-credentials.json'), format: 'json', publicFields: ['defaultChannelId', 'allowedUserIds'], mode: 0o600 },
		{ id: 'slack-agent-identities', filePath: path.join(home, SLACK_AGENT_IDENTITY_CONSTANTS.STORE_FILENAME), format: 'json', publicFields: ['version'], mode: 0o600 },
		{ id: 'slack-cloud-config', filePath: path.join(home, SLACK_CLOUD_CONSTANTS.CONFIG_CACHE_FILENAME), format: 'json', publicFields: ['version', 'fetchedAt'], mode: 0o600 },
		{ id: 'telegram-credentials', filePath: path.join(legacyHome, TELEGRAM_CONSTANTS.CREDENTIALS_FILE), format: 'json', publicFields: ['defaultChatId', 'allowedUserIds'], mode: 0o600 },
		{ id: 'credential-store-key', filePath: path.join(legacyHome, 'credentials', 'master.key'), format: 'binary', mode: 0o600 },
	];
}

/** A path agents must not read: a file or a whole directory. */
export interface GuardedPath {
	/** Rule id reported when an agent touches it. */
	id: string;
	/** Absolute path. */
	path: string;
	/** Whole subtree. */
	isDirectory: boolean;
}

/**
 * Every credential location the runtime guard (layer 2) refuses to agents:
 * the sealed files above plus the ones not sealed yet (settings.json API
 * keys, the messenger route's files, WhatsApp session state, Claude account
 * logins, the encrypted credential store) and the `file` secret store.
 *
 * @returns Paths, de-duplicated
 */
export function getGuardedCredentialPaths(): GuardedPath[] {
	const home = getCrewlyHomePath();
	const legacyHome = homeCrewlyDir();
	const out: GuardedPath[] = [];
	const seen = new Set<string>();
	const add = (id: string, p: string, isDirectory: boolean): void => {
		const abs = path.resolve(p);
		if (seen.has(abs)) return;
		seen.add(abs);
		out.push({ id, path: abs, isDirectory });
	};
	for (const spec of getSealedCredentialFiles()) {
		if (spec.id === 'cloud-config') add(spec.id, path.dirname(spec.filePath), true);
		else if (spec.id === 'credential-store-key') add('credential-store', path.dirname(spec.filePath), true);
		else add(spec.id, spec.filePath, false);
	}
	add('settings-api-keys', path.join(home, 'settings.json'), false);
	for (const platform of ['slack', 'telegram', 'discord', 'google-chat']) {
		add(`${platform}-credentials`, path.join(legacyHome, `${platform}-credentials.json`), false);
	}
	add('credential-store', path.join(home, 'credentials'), true);
	add('whatsapp-session', path.join(home, WHATSAPP_CONSTANTS.AUTH_DIR), true);
	add('claude-accounts', path.join(home, HARNESS_CONSTANTS.CLAUDE.ACCOUNTS.DIR), true);
	add('secret-store', getSecretsDir(), true);
	return out;
}

/** What the migration did to one file. */
export type CredentialMigrationOutcome = 'sealed' | 'already-sealed' | 'missing' | 'unsealed' | 'plain' | 'failed';

/** Migration report. */
export interface CredentialMigrationReport {
	/** Store kind in use. */
	store: string;
	/** Whether a vault key was available. */
	keyAvailable: boolean;
	/** Why not, when it was not. */
	keyUnavailableReason: string | null;
	/** Per-file outcome (ids, never contents). */
	files: Array<{ id: string; outcome: CredentialMigrationOutcome; error?: string }>;
}

/**
 * Whether a file on disk is in the sealed form.
 *
 * @param spec - File
 * @returns True when sealed
 */
function isSealedOnDisk(spec: CredentialFileSpec): boolean {
	try {
		const raw = fs.readFileSync(spec.filePath);
		if (spec.format !== 'json') return isSealedText(raw);
		return isSealedJson(JSON.parse(raw.toString('utf8')));
	} catch {
		return false;
	}
}

/**
 * Seal one plain file in place, verifying it reads back identically before
 * keeping the sealed copy. On any mismatch the plain contents are restored.
 *
 * @param spec - File
 * @returns Outcome
 */
function sealOne(spec: CredentialFileSpec): { outcome: CredentialMigrationOutcome; error?: string } {
	if (!fs.existsSync(spec.filePath)) return { outcome: 'missing' };
	if (isSealedOnDisk(spec)) return { outcome: 'already-sealed' };
	const original = fs.readFileSync(spec.filePath);
	try {
		if (spec.format === 'json') {
			const parsed = JSON.parse(original.toString('utf8')) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { outcome: 'failed', error: 'not a JSON object; left as is' };
			if (!writeSecretJson(spec.filePath, parsed as Record<string, unknown>, spec.publicFields ?? [], spec.mode)) {
				return { outcome: 'plain', error: 'no vault key' };
			}
			const back = readSecretJson(spec.filePath);
			if (back.status !== 'ok' || JSON.stringify(back.value) !== JSON.stringify(reorder(parsed as Record<string, unknown>, back.value as Record<string, unknown>))) {
				throw new Error('sealed copy did not read back identically');
			}
		} else {
			if (!writeSecretBytes(spec.filePath, original, spec.mode)) return { outcome: 'plain', error: 'no vault key' };
			const back = readSecretBytes(spec.filePath);
			if (back.status !== 'ok' || !back.value.equals(original)) throw new Error('sealed copy did not read back identically');
		}
		return { outcome: 'sealed' };
	} catch (err) {
		try {
			fs.writeFileSync(spec.filePath, original, { mode: spec.mode });
		} catch {
			/* best effort: the plain copy is what we started with */
		}
		return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Put `b`'s keys in `a`'s order (sealing moves secret fields after the public
 * ones; the comparison is about values, not order).
 *
 * @param a - Original
 * @param b - Read back
 * @returns `a` with its keys ordered as in `b`
 */
function reorder(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(b)) if (k in a) out[k] = a[k];
	for (const k of Object.keys(a)) if (!(k in out)) out[k] = a[k];
	return out;
}

/**
 * Turn one sealed file back into its plain form (rollback: CREWLY_SECRET_STORE=legacy).
 *
 * @param spec - File
 * @returns Outcome
 */
function unsealOne(spec: CredentialFileSpec): { outcome: CredentialMigrationOutcome; error?: string } {
	if (!fs.existsSync(spec.filePath)) return { outcome: 'missing' };
	if (!isSealedOnDisk(spec)) return { outcome: 'plain' };
	if (spec.format === 'json') {
		const res = readSecretJson<Record<string, unknown>>(spec.filePath);
		if (res.status !== 'ok') return { outcome: 'failed', error: res.status === 'locked' ? res.message : 'missing' };
		fs.writeFileSync(spec.filePath, JSON.stringify(res.value, null, 2), { mode: spec.mode });
	} else {
		const res = readSecretBytes(spec.filePath);
		if (res.status !== 'ok') return { outcome: 'failed', error: res.status === 'locked' ? res.message : 'missing' };
		fs.writeFileSync(spec.filePath, res.value, { mode: spec.mode });
	}
	fs.chmodSync(spec.filePath, spec.mode);
	return { outcome: 'unsealed' };
}

/**
 * The store that holds the vault key on this platform, ignoring a `legacy`
 * pin — used only by the rollback to open files sealed earlier.
 *
 * @returns Platform store
 */
function platformStore(): SecretStore {
	return process.platform === 'darwin'
		? new KeychainSecretStore(path.resolve(getCrewlyHomePath()))
		: new FileSecretStore(getSecretsDir());
}

/**
 * First-boot migration (runs at every boot; idempotent): seal every listed
 * credential file that is still plain. With `CREWLY_SECRET_STORE=legacy`
 * outside tests it runs the other way and unseals them (the rollback).
 *
 * Never throws, never deletes a credential: a file that cannot be sealed and
 * verified stays plain and keeps working.
 *
 * @param specs - Files (defaults to {@link getSealedCredentialFiles})
 * @param options - `rollbackStore`: where the key of files sealed earlier is
 *   (defaults to this platform's store when the owner pinned `legacy`; tests
 *   pass a fake so no real keychain is touched)
 * @returns What happened, for the boot log
 */
export function migrateCredentialFiles(
	specs: CredentialFileSpec[] = getSealedCredentialFiles(),
	options: { rollbackStore?: SecretStore } = {},
): CredentialMigrationReport {
	const store = getSecretStore();
	const files: CredentialMigrationReport['files'] = [];
	if (store.kind === 'legacy') {
		const pinned = resolveSecretStoreKind() === 'legacy' && process.env.JEST_WORKER_ID === undefined && process.env.NODE_ENV !== 'test';
		const rollbackStore = options.rollbackStore ?? (pinned ? platformStore() : null);
		const key = rollbackStore ? getVaultKey({ create: false }, rollbackStore) : null;
		for (const spec of specs) {
			if (!key) {
				files.push({ id: spec.id, outcome: isSealedOnDisk(spec) ? 'failed' : 'plain', ...(isSealedOnDisk(spec) ? { error: 'sealed, and no vault key to open it' } : {}) });
				continue;
			}
			try {
				files.push({ id: spec.id, ...unsealOne(spec) });
			} catch (err) {
				files.push({ id: spec.id, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
			}
		}
		return { store: store.kind, keyAvailable: Boolean(key), keyUnavailableReason: key ? null : getVaultKeyUnavailableReason(), files };
	}

	const anyPlain = specs.some((s) => fs.existsSync(s.filePath) && !isSealedOnDisk(s));
	const key = getVaultKey({ create: anyPlain });
	for (const spec of specs) {
		if (!key) {
			files.push({ id: spec.id, outcome: fs.existsSync(spec.filePath) ? (isSealedOnDisk(spec) ? 'failed' : 'plain') : 'missing' });
			continue;
		}
		try {
			files.push({ id: spec.id, ...sealOne(spec) });
		} catch (err) {
			files.push({ id: spec.id, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { store: store.kind, keyAvailable: Boolean(key), keyUnavailableReason: key ? null : getVaultKeyUnavailableReason(), files };
}
